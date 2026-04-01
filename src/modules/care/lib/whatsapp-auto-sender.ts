import { randomBytes } from 'crypto';
import prisma from './prisma';
import GupshupService from './gupshup';
import WhatsAppMessageBuilder, { AppointmentData } from './whatsapp-message-builder';

type WhatsAppMessageType =
  | 'APPOINTMENT_CREATED'
  | 'APPOINTMENT_CONFIRMATION'
  | 'APPOINTMENT_REMINDER'
  | 'APPOINTMENT_CANCELED'
  | 'NO_SHOW'
  | 'CONFIRMATION_REPLY_CONFIRMED'
  | 'CONFIRMATION_REPLY_RESCHEDULE';

export interface SendWhatsAppParams {
  branchId: string;
  appointmentId: string;
  messageType: WhatsAppMessageType;
  customMessage?: string;
  skipNotificationSettings?: boolean;
}

interface FailedLogParams {
  branchId: string;
  appointmentId?: string | null;
  patientName?: string | null;
  patientPhone?: string | null;
  messageType: WhatsAppMessageType;
  message?: string;
  errorMessage: string;
}

/**
 * Helper para envio automático de mensagens WhatsApp
 */
export class WhatsAppAutoSender {
  static makePublicToken(): string {
    return randomBytes(24).toString('hex');
  }

  static getPublicAppBase(): string {
    return String(process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
  }

  static async ensureDocumentsLink(params: {
    branchId: string;
    appointment: {
      id: string;
      patientId?: string | null;
      patientName?: string | null;
      patientCpf?: string | null;
    };
    patientPhone?: string | null;
  }): Promise<string> {
    const { branchId, appointment, patientPhone } = params;

    const linkedPatient = appointment.patientId
      ? await prisma.patient.findFirst({
          where: { id: appointment.patientId, branchId, isActive: true },
          select: { id: true, name: true, cpf: true, cellphone: true, phone: true },
        })
      : null;

    const existingFlow = await prisma.preSchedulingFlow.findUnique({
      where: { appointmentId: appointment.id },
    });

    const token = existingFlow?.publicToken || this.makePublicToken();
    const publicUrl = `${this.getPublicAppBase()}/pre-agendamento/documentos/${token}`;

    await prisma.preSchedulingFlow.upsert({
      where: { appointmentId: appointment.id },
      update: {
        branchId,
        patientId: appointment.patientId || linkedPatient?.id || null,
        patientName: appointment.patientName || linkedPatient?.name || null,
        patientCpf: String(appointment.patientCpf || linkedPatient?.cpf || '').replace(/\D/g, ''),
        patientPhone: linkedPatient?.cellphone || linkedPatient?.phone || patientPhone || null,
        publicToken: existingFlow?.publicToken || token,
        status: existingFlow?.status || 'WAITING_PATIENT_DOCUMENTS',
        linkSentAt: existingFlow?.linkSentAt || new Date(),
        patientVerifiedAt: null,
        patientVerifiedCpf: null,
        patientVerifiedName: null,
        patientVerifiedTrust: null,
        patientAccessExpiresAt: null,
        patientSubmittedAt: null,
      },
      create: {
        branchId,
        appointmentId: appointment.id,
        patientId: appointment.patientId || linkedPatient?.id || null,
        patientName: appointment.patientName || linkedPatient?.name || null,
        patientCpf: String(appointment.patientCpf || linkedPatient?.cpf || '').replace(/\D/g, ''),
        patientPhone: linkedPatient?.cellphone || linkedPatient?.phone || patientPhone || null,
        publicToken: token,
        status: 'WAITING_PATIENT_DOCUMENTS',
        linkSentAt: new Date(),
        linkSentByUserId: null,
      },
    });

    return publicUrl;
  }

  static async createFailedLog(params: FailedLogParams): Promise<void> {
    try {
      await prisma.whatsAppMessageLog.create({
        data: {
          branchId: params.branchId,
          appointmentId: params.appointmentId || null,
          patientName: params.patientName || null,
          patientPhone: params.patientPhone || 'N/A',
          messageType: params.messageType,
          message: params.message || '',
          status: 'FAILED',
          errorMessage: params.errorMessage,
        },
      });
    } catch (error) {
      console.error('Failed to create WhatsApp failure log:', error);
    }
  }

  static async hasPendingOrSentLog(
    branchId: string,
    appointmentId: string,
    messageType: WhatsAppMessageType,
  ): Promise<boolean> {
    const existingLog = await prisma.whatsAppMessageLog.findFirst({
      where: {
        branchId,
        appointmentId,
        messageType,
        status: {
          in: ['SENT', 'PENDING'],
        },
      },
      select: { id: true },
    });

    return Boolean(existingLog);
  }
  
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
        const errorMessage = 'Paciente não possui telefone cadastrado';
        await this.createFailedLog({
          branchId: params.branchId,
          appointmentId: appointment.id,
          patientName: appointment.patientName,
          patientPhone: null,
          messageType: params.messageType,
          errorMessage,
        });
        return { success: false, error: errorMessage };
      }

      // Buscar configuração do WhatsApp
      const whatsappConfig = await prisma.whatsAppConfig.findUnique({
        where: { branchId: params.branchId },
      });

      if (whatsappConfig && !whatsappConfig.isActive) {
        const errorMessage = 'WhatsApp está desativado para esta filial';
        await this.createFailedLog({
          branchId: params.branchId,
          appointmentId: appointment.id,
          patientName: appointment.patientName,
          patientPhone,
          messageType: params.messageType,
          errorMessage,
        });
        return { success: false, error: errorMessage };
      }

      // Buscar configuração de notificações
      const notificationConfig = await prisma.whatsAppNotificationConfig.findUnique({
        where: { branchId: params.branchId },
      });

      // Verificar se deve enviar mensagem baseado no tipo
      if (!params.skipNotificationSettings && params.messageType === 'APPOINTMENT_CREATED' && notificationConfig && !notificationConfig.sendOnAppointmentCreated) {
        const errorMessage = 'Envio de mensagem ao criar agendamento está desativado';
        await this.createFailedLog({
          branchId: params.branchId,
          appointmentId: appointment.id,
          patientName: appointment.patientName,
          patientPhone,
          messageType: params.messageType,
          errorMessage,
        });
        return { success: false, error: errorMessage };
      }

      if (!params.skipNotificationSettings && params.messageType === 'APPOINTMENT_CONFIRMATION' && notificationConfig && !notificationConfig.sendConfirmationEnabled) {
        const errorMessage = 'Envio de confirmação de agendamento está desativado';
        await this.createFailedLog({
          branchId: params.branchId,
          appointmentId: appointment.id,
          patientName: appointment.patientName,
          patientPhone,
          messageType: params.messageType,
          errorMessage,
        });
        return { success: false, error: errorMessage };
      }

      if (!params.skipNotificationSettings && params.messageType === 'APPOINTMENT_REMINDER' && notificationConfig && !notificationConfig.sendReminderEnabled) {
        const errorMessage = 'Envio de lembrete está desativado';
        await this.createFailedLog({
          branchId: params.branchId,
          appointmentId: appointment.id,
          patientName: appointment.patientName,
          patientPhone,
          messageType: params.messageType,
          errorMessage,
        });
        return { success: false, error: errorMessage };
      }

      const branch = await prisma.branch.findUnique({
        where: { id: params.branchId },
        select: { tradeName: true, address: true },
      });

      const documentsLink = params.messageType === 'APPOINTMENT_CREATED'
        ? await this.ensureDocumentsLink({
            branchId: params.branchId,
            appointment: {
              id: appointment.id,
              patientId: appointment.patientId,
              patientName: appointment.patientName,
              patientCpf: appointment.patientCpf,
            },
            patientPhone,
          })
        : '';

      const appointmentData: AppointmentData = {
        patientName: appointment.patientName,
        patientCpf: appointment.patientCpf,
        doctorName: appointment.doctorName,
        specialty: appointment.specialty,
        date: appointment.date,
        time: appointment.time,
        convenio: appointment.convenio,
        observations: appointment.observations,
        clinicName: branch?.tradeName || '',
        location: branch?.tradeName || branch?.address || '',
        professional: appointment.doctorName || '',
        documentsLink,
      };

      // Buscar template de mensagem
      let message: string;
      let templateRecord: Awaited<ReturnType<typeof prisma.whatsAppMessageTemplate.findFirst>> | null = null;
      if (params.customMessage) {
        message = params.customMessage;
      } else {
        templateRecord = await prisma.whatsAppMessageTemplate.findFirst({
          where: {
            branchId: params.branchId,
            type: params.messageType,
            isActive: true,
          },
        });

        if (!templateRecord) {
          const errorMessage = 'Template de mensagem não encontrado';
          await this.createFailedLog({
            branchId: params.branchId,
            appointmentId: appointment.id,
            patientName: appointment.patientName,
            patientPhone,
            messageType: params.messageType,
            errorMessage,
          });
          return { success: false, error: errorMessage };
        }
        message = WhatsAppMessageBuilder.buildMessage(templateRecord.message, appointmentData);
      }

      const apiKey = whatsappConfig?.accountSid || process.env.GUPSHUP_API_KEY || '';
      const appName = whatsappConfig?.authToken || process.env.GUPSHUP_APP_NAME || '';
      const sourceNumber = whatsappConfig?.fromNumber || process.env.GUPSHUP_SOURCE_NUMBER || '';

      if (!apiKey || !appName || !sourceNumber) {
        const errorMessage = 'WhatsApp não está configurado. Salve as credenciais da filial ou defina GUPSHUP_API_KEY, GUPSHUP_APP_NAME e GUPSHUP_SOURCE_NUMBER.';
        await this.createFailedLog({
          branchId: params.branchId,
          appointmentId: appointment.id,
          patientName: appointment.patientName,
          patientPhone,
          messageType: params.messageType,
          message,
          errorMessage,
        });
        return { success: false, error: errorMessage };
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

      // Enviar mensagem via Gupshup
      const gupshup = new GupshupService({
        apiKey,
        appName,
        sourceNumber,
      });

      let result;
      if (
        !params.customMessage
        && templateRecord?.hsmTemplateApproved
        && (templateRecord?.hsmTemplateId || templateRecord?.hsmTemplateName)
      ) {
        const hsmParams = WhatsAppMessageBuilder.extractTemplateParams(templateRecord.message, appointmentData);
        result = await gupshup.sendTemplateMessage({
          to: patientPhone,
          templateId: templateRecord.hsmTemplateId || templateRecord.hsmTemplateName!,
          params: hsmParams,
        });

        if (result.status === 'error') {
          console.warn('[whatsapp-auto-sender] HSM template falhou:', result.error);
        }
      }

      if (
        (!result || result.status === 'error')
        && !params.customMessage
        && params.messageType === 'APPOINTMENT_CONFIRMATION'
      ) {
        result = await gupshup.sendQuickReplyMessage({
          to: patientPhone,
          body: message,
          msgId: messageLog.id,
          options: [
            { title: 'Confirmar', postbackText: 'CONFIRM_APPOINTMENT' },
            { title: 'Reagendar', postbackText: 'RESCHEDULE_APPOINTMENT' },
          ],
        });

        if (result.status === 'error') {
          console.warn('[whatsapp-auto-sender] quick reply falhou, tentando texto simples:', result.error);
        }
      }

      if (!result || result.status === 'error') {
        result = await gupshup.sendTextMessage({
          to: patientPhone,
          message,
        });
      }

      // Atualizar log com resultado
      if (result.status === 'success') {
        await prisma.whatsAppMessageLog.update({
          where: { id: messageLog.id },
          data: {
            status: 'SENT',
            providerMessageId: result.messageId,
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
    }).then((result) => {
      if (!result.success) {
        console.warn('[whatsapp-auto-sender] appointment created message not sent:', {
          branchId,
          appointmentId,
          error: result.error,
        });
      }
    }).catch(err => {
      console.error('Failed to send appointment created message:', err);
    });
  }

  static async sendNoShowMessageIfNeeded(branchId: string, appointmentId: string): Promise<void> {
    try {
      const alreadySent = await this.hasPendingOrSentLog(branchId, appointmentId, 'NO_SHOW');
      if (alreadySent) return;

      await this.sendMessage({
        branchId,
        appointmentId,
        messageType: 'NO_SHOW',
      });
    } catch (err) {
      console.error('Failed to send no-show message:', err);
    }
  }

  static async sendExamResultReadyMessage(params: {
    branchId: string;
    appointmentId: string;
    patientName?: string | null;
    examName?: string | null;
    clinicName?: string | null;
  }): Promise<{ success: boolean; error?: string }> {
    const patientName = (params.patientName || '').trim();
    const examName = (params.examName || 'seu exame').trim();
    const clinicName = (params.clinicName || 'nossa clínica').trim();

    const message = [
      `Olá${patientName ? `, ${patientName}` : ''}!`,
      `Seu resultado de ${examName} já está pronto em ${clinicName}.`,
      'Recomendamos agendar sua consulta de retorno para avaliação médica.',
      'Se precisar, nossa equipe pode ajudar com o agendamento.',
    ].join('\n');

    return this.sendMessage({
      branchId: params.branchId,
      appointmentId: params.appointmentId,
      messageType: 'APPOINTMENT_REMINDER',
      customMessage: message,
      skipNotificationSettings: true,
    });
  }
}

export default WhatsAppAutoSender;
