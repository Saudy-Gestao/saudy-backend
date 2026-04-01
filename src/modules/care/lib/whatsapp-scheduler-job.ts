import type { Prisma } from '@prisma/client';
import prisma from './prisma';
import WhatsAppAutoSender from './whatsapp-auto-sender';
import dayjs from 'dayjs';

/**
 * Job para processar e enviar mensagens de confirmação de agendamentos
 */
export class WhatsAppSchedulerJob {
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
      // Janela real: do momento atual até as próximas N horas
      const now = dayjs();
      const windowEnd = now.add(hoursBefore, 'hour');

      // Buscar agendamentos ativos da filial e filtrar pela janela
      const appointments = await prisma.appointment.findMany({
        where: {
          branchId,
          isActive: true,
          status: {
            notIn: ['CANCELADO', 'CANCELED', 'NAO_COMPARECEU', 'NO_SHOW', 'COMPLETED', 'FINALIZADO', 'REALIZADO'],
          },
          date: {
            gte: now.format('YYYY-MM-DD'),
            lte: windowEnd.format('YYYY-MM-DD'),
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
              in: ['SENT', 'PENDING'],
            },
          },
        });

        if (existingLog) {
          continue; // Já enviou confirmação
        }

        if (!appointment.date || !appointment.time) {
          continue;
        }

        const appointmentDateTime = dayjs(`${appointment.date} ${appointment.time}`);
        if (!appointmentDateTime.isValid()) {
          continue;
        }

        if (appointmentDateTime.isBefore(now) || appointmentDateTime.isAfter(windowEnd)) {
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
      const threshold = dayjs().subtract(toleranceMinutes, 'minute');
      const thresholdDate = threshold.format('YYYY-MM-DD');
      const thresholdTime = threshold.format('HH:mm');

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
