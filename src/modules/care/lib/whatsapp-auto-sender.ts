import prisma from './prisma';
import TwilioService from './twilio';
import WhatsAppMessageBuilder, { AppointmentData } from './whatsapp-message-builder';

type WhatsAppMessageType = 'APPOINTMENT_CREATED' | 'APPOINTMENT_CONFIRMATION' | 'APPOINTMENT_REMINDER' | 'APPOINTMENT_CANCELED';

export interface SendWhatsAppParams {
  branchId: string;
  appointmentId: string;
  messageType: WhatsAppMessageType;
  customMessage?: string;
}

/**
 * Helper para envio automático de mensagens WhatsApp
 */
export class WhatsAppAutoSender {
  
  /**
   * Envia mensagem WhatsApp para um agendamento
   */
  static async sendMessage(params: SendWhatsAppParams): Promise<{ success: boolean; error?: string }> {
    try {
      // Buscar agendamento
      const appointment = await prisma.appointment.findFirst({
        where: { id: params.appointmentId, branchId: params.branchId },
      });

      if (!appointment) {
        return { success: false, error: 'Agendamento não encontrado' };
      }

      // Buscar telefone do paciente
      let patientPhone: string | null = null;
      if (appointment.patientId) {
        const patient = await prisma.patient.findUnique({
          where: { id: appointment.patientId },
          select: { cellphone: true },
        });
        patientPhone = patient?.cellphone || null;
      }

      if (!patientPhone) {
        return { success: false, error: 'Paciente não possui telefone cadastrado' };
      }

      // Buscar configuração do WhatsApp
      const whatsappConfig = await prisma.whatsAppConfig.findUnique({
        where: { branchId: params.branchId },
      });

      if (!whatsappConfig || !whatsappConfig.isActive) {
        return { success: false, error: 'WhatsApp não está configurado' };
      }

      // Buscar configuração de notificações
      const notificationConfig = await prisma.whatsAppNotificationConfig.findUnique({
        where: { branchId: params.branchId },
      });

      // Verificar se deve enviar mensagem baseado no tipo
      if (params.messageType === 'APPOINTMENT_CREATED' && notificationConfig && !notificationConfig.sendOnAppointmentCreated) {
        return { success: false, error: 'Envio de mensagem ao criar agendamento está desativado' };
      }

      if (params.messageType === 'APPOINTMENT_CONFIRMATION' && notificationConfig && !notificationConfig.sendConfirmationEnabled) {
        return { success: false, error: 'Envio de confirmação de agendamento está desativado' };
      }

      if (params.messageType === 'APPOINTMENT_REMINDER' && notificationConfig && !notificationConfig.sendReminderEnabled) {
        return { success: false, error: 'Envio de lembrete está desativado' };
      }

      // Buscar template de mensagem
      let message: string;
      if (params.customMessage) {
        message = params.customMessage;
      } else {
        const template = await prisma.whatsAppMessageTemplate.findFirst({
          where: {
            branchId: params.branchId,
            type: params.messageType,
            isActive: true,
          },
        });

        if (!template) {
          return { success: false, error: 'Template de mensagem não encontrado' };
        }

        // Construir mensagem com os dados do agendamento
        const appointmentData: AppointmentData = {
          patientName: appointment.patientName,
          patientCpf: appointment.patientCpf,
          doctorName: appointment.doctorName,
          specialty: appointment.specialty,
          date: appointment.date,
          time: appointment.time,
          convenio: appointment.convenio,
          observations: appointment.observations,
        };

        message = WhatsAppMessageBuilder.buildMessage(template.message, appointmentData);
      }

      // Criar log antes de enviar
      const messageLog = await prisma.whatsAppMessageLog.create({
        data: {
          branchId: params.branchId,
          appointmentId: appointment.id,
          patientName: appointment.patientName,
          patientPhone,
          messageType: params.messageType,
          message,
          status: 'PENDING',
        },
      });

      // Enviar mensagem via Twilio
      const twilio = new TwilioService({
        accountSid: whatsappConfig.accountSid,
        authToken: whatsappConfig.authToken,
        fromNumber: whatsappConfig.fromNumber,
      });

      const result = await twilio.sendTextMessage({
        to: patientPhone,
        message,
      });

      // Atualizar log com resultado
      if (result.status === 'success') {
        await prisma.whatsAppMessageLog.update({
          where: { id: messageLog.id },
          data: {
            status: 'SENT',
            twilioSid: result.messageId,
            sentAt: new Date(),
          },
        });

        return { success: true };
      } else {
        await prisma.whatsAppMessageLog.update({
          where: { id: messageLog.id },
          data: {
            status: 'FAILED',
            errorMessage: result.error,
          },
        });

        return { success: false, error: result.error };
      }
    } catch (error: any) {
      console.error('Error sending WhatsApp message:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Envia mensagem de agendamento criado (chamado após criar agendamento)
   */
  static async sendAppointmentCreatedMessage(branchId: string, appointmentId: string): Promise<void> {
    // Fire and forget - não bloqueia criação do agendamento
    this.sendMessage({
      branchId,
      appointmentId,
      messageType: 'APPOINTMENT_CREATED',
    }).catch(err => {
      console.error('Failed to send appointment created message:', err);
    });
  }
}

export default WhatsAppAutoSender;
