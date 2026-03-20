import prisma from './prisma';
import WhatsAppAutoSender from './whatsapp-auto-sender';
import dayjs from 'dayjs';

/**
 * Job para processar e enviar mensagens de confirmação de agendamentos
 */
export class WhatsAppSchedulerJob {
  
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
      // Calcular janela de tempo
      const targetDate = dayjs().add(hoursBefore, 'hour');
      const dateStr = targetDate.format('YYYY-MM-DD');
      const currentHour = targetDate.format('HH:mm');

      // Buscar agendamentos para a data/hora alvo que ainda não tiveram confirmação enviada
      const appointments = await prisma.appointment.findMany({
        where: {
          branchId,
          date: dateStr,
          status: {
            not: 'CANCELADO',
          },
          isActive: true,
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

        // Verificar se o horário está próximo do horário do agendamento
        // (tolerância de ±1 hora para evitar enviar múltiplas vezes)
        if (appointment.time) {
          const appointmentHour = dayjs(`${dateStr} ${appointment.time}`);
          const diffHours = appointmentHour.diff(dayjs(), 'hour');
          
          // Se está entre hoursBefore-1 e hoursBefore+1
          if (diffHours >= hoursBefore - 1 && diffHours <= hoursBefore + 1) {
            // Enviar confirmação
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
        }
      }

      return { processed, sent, failed };
    } catch (error) {
      console.error(`Error processing confirmations for branch ${branchId}:`, error);
      return { processed, sent, failed };
    }
  }

  /**
   * Processa lembretes de agendamentos (similar ao de confirmações)
   */
  static async processReminders(): Promise<{ processed: number; sent: number; failed: number }> {
    let processed = 0;
    let sent = 0;
    let failed = 0;

    try {
      // Buscar todas as branches com lembretes habilitados
      const configs = await prisma.whatsAppNotificationConfig.findMany({
        where: {
          sendReminderEnabled: true,
        },
      });

      for (const config of configs) {
        const result = await this.processRemindersForBranch(
          config.branchId,
          config.reminderHoursBefore
        );
        processed += result.processed;
        sent += result.sent;
        failed += result.failed;
      }

      return { processed, sent, failed };
    } catch (error) {
      console.error('Error processing reminders:', error);
      return { processed, sent, failed };
    }
  }

  /**
   * Processa lembretes para uma branch específica
   */
  private static async processRemindersForBranch(
    branchId: string,
    hoursBefore: number
  ): Promise<{ processed: number; sent: number; failed: number }> {
    let processed = 0;
    let sent = 0;
    let failed = 0;

    try {
      // Calcular janela de tempo
      const targetDate = dayjs().add(hoursBefore, 'hour');
      const dateStr = targetDate.format('YYYY-MM-DD');

      // Buscar agendamentos para a data/hora alvo
      const appointments = await prisma.appointment.findMany({
        where: {
          branchId,
          date: dateStr,
          status: {
            not: 'CANCELADO',
          },
          isActive: true,
        },
      });

      for (const appointment of appointments) {
        processed++;

        // Verificar se já enviou lembrete para este agendamento
        const existingLog = await prisma.whatsAppMessageLog.findFirst({
          where: {
            appointmentId: appointment.id,
            messageType: 'APPOINTMENT_REMINDER',
            status: {
              in: ['SENT', 'PENDING'],
            },
          },
        });

        if (existingLog) {
          continue;
        }

        // Verificar horário
        if (appointment.time) {
          const appointmentHour = dayjs(`${dateStr} ${appointment.time}`);
          const diffHours = appointmentHour.diff(dayjs(), 'hour');
          
          if (diffHours >= hoursBefore - 1 && diffHours <= hoursBefore + 1) {
            const result = await WhatsAppAutoSender.sendMessage({
              branchId,
              appointmentId: appointment.id,
              messageType: 'APPOINTMENT_REMINDER',
            });

            if (result.success) {
              sent++;
            } else {
              failed++;
              console.error(`Failed to send reminder for appointment ${appointment.id}:`, result.error);
            }
          }
        }
      }

      return { processed, sent, failed };
    } catch (error) {
      console.error(`Error processing reminders for branch ${branchId}:`, error);
      return { processed, sent, failed };
    }
  }
}

export default WhatsAppSchedulerJob;
