import type { Prisma } from '@prisma/client';
import prisma from './prisma';
import WhatsAppAutoSender from './whatsapp-auto-sender';
import GupshupService from './gupshup';

const CLINIC_TIME_ZONE = process.env.APP_TIMEZONE || process.env.TZ || 'America/Sao_Paulo';

const getTimeZoneParts = (date: Date, timeZone = CLINIC_TIME_ZONE) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const readPart = (type: string) => parts.find((item) => item.type === type)?.value || '';

  return {
    year: readPart('year'),
    month: readPart('month'),
    day: readPart('day'),
    hour: readPart('hour'),
    minute: readPart('minute'),
  };
};

const formatDateInTimeZone = (date: Date, timeZone = CLINIC_TIME_ZONE) => {
  const { year, month, day } = getTimeZoneParts(date, timeZone);
  return `${year}-${month}-${day}`;
};

const formatTimeInTimeZone = (date: Date, timeZone = CLINIC_TIME_ZONE) => {
  const { hour, minute } = getTimeZoneParts(date, timeZone);
  return `${hour}:${minute}`;
};

/**
 * Job para processar e enviar mensagens de confirmação de agendamentos
 */
export class WhatsAppSchedulerJob {
  static async processHumanConversationTimeouts(): Promise<{ warned: number; closed: number; failed: number }> {
    let warned = 0;
    let closed = 0;
    let failed = 0;

    try {
      const conversations = await prisma.whatsAppConversation.findMany({
        where: {
          humanStatus: 'ASSIGNED',
          humanAssignedUserId: { not: null },
        },
        include: {
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      });

      for (const conversation of conversations) {
        try {
          const settings = await prisma.whatsAppConversationSettings.findUnique({
            where: { branchId: conversation.branchId },
          });

          const idleMinutes = Math.max(1, Number(settings?.idleTimeoutMinutes || 25));
          const warningMinutes = Math.max(1, Number(settings?.closeWarningMinutes || 5));
          const lastOperatorAt = conversation.humanLastOperatorMessageAt || null;
          const lastPatientAt = conversation.humanLastPatientMessageAt || null;

          if (!lastOperatorAt) continue;
          if (lastPatientAt && lastPatientAt >= lastOperatorAt) continue;

          const now = Date.now();
          const idleMs = idleMinutes * 60 * 1000;
          const warningMs = warningMinutes * 60 * 1000;
          const branchConfig = await this.getBranchMessagingConfig(conversation.branchId);
          if (!branchConfig) continue;

          const gupshup = new GupshupService(branchConfig);

          if (!conversation.humanIdleWarningSentAt && (now - lastOperatorAt.getTime()) >= idleMs) {
            const warningMessage = `Como não tivemos retorno nos últimos ${idleMinutes} minutos, este atendimento será encerrado automaticamente em ${warningMinutes} minutos caso não haja nova mensagem.`;
            const result = await gupshup.sendTextMessage({
              to: conversation.phone,
              message: warningMessage,
            });

            const sentAt = new Date();
            await prisma.whatsAppConversation.update({
              where: { id: conversation.id },
              data: {
                humanIdleWarningSentAt: sentAt,
                lastOutboundMessage: warningMessage,
                lastInteractionAt: sentAt,
              },
            });

            await prisma.whatsAppConversationMessage.create({
              data: {
                conversationId: conversation.id,
                branchId: conversation.branchId,
                phone: conversation.phone,
                flowKey: conversation.humanFlowKey || null,
                authorType: 'SYSTEM',
                authorUserId: conversation.humanAssignedUserId || null,
                authorName: conversation.humanAssignedUserName || 'Sistema',
                providerMessageId: result.messageId || null,
                metadata: { event: 'idle-warning' },
                message: warningMessage,
              },
            });
            warned += 1;
            continue;
          }

          if (conversation.humanIdleWarningSentAt && (now - conversation.humanIdleWarningSentAt.getTime()) >= warningMs) {
            const closingMessage = 'Seu atendimento foi encerrado automaticamente por inatividade. Se precisar de algo mais, envie uma nova mensagem e o fluxo será iniciado novamente.';
            const result = await gupshup.sendTextMessage({
              to: conversation.phone,
              message: closingMessage,
            });

            const closedAt = new Date();
            await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
              await tx.whatsAppConversation.update({
                where: { id: conversation.id },
                data: {
                  state: 'MENU',
                  context: {},
                  selectedService: null,
                  humanStatus: 'CLOSED',
                  humanAssignedUserId: null,
                  humanAssignedUserName: null,
                  humanClosedAt: closedAt,
                  humanClosedByUserId: conversation.humanAssignedUserId || null,
                  humanClosedByUserName: conversation.humanAssignedUserName || 'Sistema',
                  humanProtocolClosedAt: closedAt,
                  humanIdleWarningSentAt: null,
                  lastOutboundMessage: closingMessage,
                  lastInteractionAt: closedAt,
                },
              });

              await tx.whatsAppConversationMessage.create({
                data: {
                  conversationId: conversation.id,
                  branchId: conversation.branchId,
                  phone: conversation.phone,
                  flowKey: conversation.humanFlowKey || null,
                  authorType: 'SYSTEM',
                  authorUserId: conversation.humanAssignedUserId || null,
                  authorName: conversation.humanAssignedUserName || 'Sistema',
                  providerMessageId: result.messageId || null,
                  metadata: { event: 'idle-auto-close' },
                  message: `[Protocolo ${conversation.humanProtocolNumber || '-'}] Atendimento encerrado automaticamente por inatividade.\n${closingMessage}`,
                },
              });
            });
            closed += 1;
          }
        } catch (error) {
          failed += 1;
          console.error(`Error processing human timeout for conversation ${conversation.id}:`, error);
        }
      }

      return { warned, closed, failed };
    } catch (error) {
      console.error('Error processing human conversation timeouts:', error);
      return { warned, closed, failed };
    }
  }

  private static async getBranchMessagingConfig(branchId: string) {
    const whatsappConfig = await prisma.whatsAppConfig.findUnique({ where: { branchId } });
    if (whatsappConfig?.isActive) {
      return {
        apiKey: whatsappConfig.accountSid,
        appName: whatsappConfig.authToken,
        sourceNumber: whatsappConfig.fromNumber,
      };
    }

    return null;
  }

  static async processNoShows(): Promise<{ processed: number; updated: number; notified: number; failed: number }> {
    let processed = 0;
    let updated = 0;
    let notified = 0;
    let failed = 0;

    try {
      const branches = await prisma.branch.findMany({
        select: { id: true },
      });

      for (const branch of branches) {
        const result = await this.processNoShowsForBranch(branch.id);
        processed += result.processed;
        updated += result.updated;
        notified += result.notified;
        failed += result.failed;
      }

      return { processed, updated, notified, failed };
    } catch (error) {
      console.error('Error processing no-shows:', error);
      return { processed, updated, notified, failed };
    }
  }
  
  /**
   * Processa agendamentos e envia confirmações baseado nas configurações
   */
  static async processConfirmations(): Promise<{ processed: number; sent: number; failed: number }> {
    let processed = 0;
    let sent = 0;
    let failed = 0;

    try {
      // Buscar todas as branches com WhatsApp configurado
      const configs = await prisma.whatsAppNotificationConfig.findMany({
        where: {
          sendConfirmationEnabled: true,
        },
      });

      for (const config of configs) {
        const result = await this.processConfirmationsForBranch(
          config.branchId,
          config.confirmationHoursBefore
        );
        processed += result.processed;
        sent += result.sent;
        failed += result.failed;
      }

      return { processed, sent, failed };
    } catch (error) {
      console.error('Error processing confirmations:', error);
      return { processed, sent, failed };
    }
  }

  /**
   * Processa confirmações para uma branch específica
   */
  private static async processConfirmationsForBranch(
    branchId: string,
    hoursBefore: number
  ): Promise<{ processed: number; sent: number; failed: number }> {
    let processed = 0;
    let sent = 0;
    let failed = 0;

    try {
      // Janela real: do momento atual até as próximas N horas, no fuso da clínica.
      const now = new Date();
      const windowEnd = new Date(now.getTime() + (hoursBefore * 60 * 60 * 1000));
      const nowDate = formatDateInTimeZone(now);
      const windowEndDate = formatDateInTimeZone(windowEnd);
      const nowComparable = `${nowDate} ${formatTimeInTimeZone(now)}`;
      const windowEndComparable = `${windowEndDate} ${formatTimeInTimeZone(windowEnd)}`;

      // Buscar agendamentos ativos da filial e filtrar pela janela
      const appointments = await prisma.appointment.findMany({
        where: {
          branchId,
          isActive: true,
          status: {
            notIn: ['CANCELADO', 'CANCELED', 'NAO_COMPARECEU', 'NO_SHOW', 'COMPLETED', 'FINALIZADO', 'REALIZADO', 'CONFIRMADO', 'CONFIRMED'],
          },
          date: {
            gte: nowDate,
            lte: windowEndDate,
          },
        },
      });

      for (const appointment of appointments) {
        processed++;

        // Verificar se já enviou confirmação para este agendamento
        const existingLog = await prisma.whatsAppMessageLog.findFirst({
          where: {
            appointmentId: appointment.id,
            messageType: 'APPOINTMENT_CONFIRMATION',
            status: {
              in: ['SENT', 'PENDING', 'RESPONDED_CONFIRMED', 'RESPONDED_RESCHEDULE'],
            },
          },
        });

        if (existingLog) {
          continue; // Já enviou confirmação
        }

        if (!appointment.date || !appointment.time) {
          continue;
        }

        const appointmentComparable = `${appointment.date} ${appointment.time.slice(0, 5)}`;

        if (appointmentComparable < nowComparable || appointmentComparable > windowEndComparable) {
          continue;
        }

        const result = await WhatsAppAutoSender.sendMessage({
          branchId,
          appointmentId: appointment.id,
          messageType: 'APPOINTMENT_CONFIRMATION',
        });

        if (result.success) {
          sent++;
        } else {
          failed++;
          console.error(`Failed to send confirmation for appointment ${appointment.id}:`, result.error);
        }
      }

      return { processed, sent, failed };
    } catch (error) {
      console.error(`Error processing confirmations for branch ${branchId}:`, error);
      return { processed, sent, failed };
    }
  }

  private static async processNoShowsForBranch(
    branchId: string,
  ): Promise<{ processed: number; updated: number; notified: number; failed: number }> {
    let processed = 0;
    let updated = 0;
    let notified = 0;
    let failed = 0;

    try {
      const settings = await prisma.branchSettings.findUnique({ where: { branchId } });
      const toleranceMinutes = Math.max(0, Number(settings?.noShowToleranceMinutes ?? 30));
      const threshold = new Date(Date.now() - (toleranceMinutes * 60 * 1000));
      const thresholdDate = formatDateInTimeZone(threshold);
      const thresholdTime = formatTimeInTimeZone(threshold);

      const candidates = await prisma.appointment.findMany({
        where: {
          branchId,
          isActive: true,
          status: { in: ['AGENDADO', 'CONFIRMADO', 'SCHEDULED', 'CONFIRMED'] },
          OR: [
            { date: { lt: thresholdDate } },
            {
              AND: [
                { date: thresholdDate },
                { time: { lte: thresholdTime } },
              ],
            },
          ],
        },
        select: { id: true },
        take: 500,
      });

      processed = candidates.length;
      if (!candidates.length) {
        return { processed, updated, notified, failed };
      }

      const appointmentIds = candidates.map((item: { id: string }) => item.id);

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.appointment.updateMany({
          where: { id: { in: appointmentIds } },
          data: { status: 'NAO_COMPARECEU' },
        });

        await tx.mwlEntry.updateMany({
          where: { appointmentId: { in: appointmentIds } },
          data: { status: 'cancelado', isActive: false },
        });
      });

      updated = appointmentIds.length;

      for (const appointmentId of appointmentIds) {
        const alreadySent = await WhatsAppAutoSender.hasPendingOrSentLog(branchId, appointmentId, 'NO_SHOW');
        if (alreadySent) {
          continue;
        }

        const result = await WhatsAppAutoSender.sendMessage({
          branchId,
          appointmentId,
          messageType: 'NO_SHOW',
        });

        if (result.success) {
          notified += 1;
        } else {
          failed += 1;
          console.error(`Failed to send no-show message for appointment ${appointmentId}:`, result.error);
        }
      }

      return { processed, updated, notified, failed };
    } catch (error) {
      console.error(`Error processing no-shows for branch ${branchId}:`, error);
      return { processed, updated, notified, failed };
    }
  }

  /**
   * Processa lembretes de agendamentos (similar ao de confirmações)
   */
  static async processReminders(): Promise<{ processed: number; sent: number; failed: number }> {
    return { processed: 0, sent: 0, failed: 0 };
  }

  /**
   * Processa lembretes para uma branch específica
   */
  private static async processRemindersForBranch(
    branchId: string,
    hoursBefore: number
  ): Promise<{ processed: number; sent: number; failed: number }> {
    void branchId;
    void hoursBefore;
    return { processed: 0, sent: 0, failed: 0 };
  }
}

export default WhatsAppSchedulerJob;
