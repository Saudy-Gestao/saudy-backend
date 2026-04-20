import { randomBytes } from 'crypto';
import prisma from './prisma';
import GupshupService from './gupshup';
import WhatsAppMessageBuilder, { AppointmentData } from './whatsapp-message-builder';
import { resolveWhatsAppConfigForBranch } from './whatsapp-config-resolver';

type WhatsAppMessageType =
  | 'APPOINTMENT_CREATED'
  | 'APPOINTMENT_CONFIRMATION'
  | 'APPOINTMENT_REMINDER'
  | 'EXAM_REPORT_READY'
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
  quickReplyOptions?: Array<{ title: string; postbackText: string }>;
  customTemplateData?: Partial<AppointmentData>;
  requireApprovedTemplate?: boolean;
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

const normalizeStatusKey = (value?: string | null) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toUpperCase()
  .replace(/\s+/g, '_');

const isValidTime = (value?: string | null) => /^\d{2}:\d{2}$/.test(String(value || '').trim());

const addBusinessDays = (baseDate: Date, businessDays: number) => {
  let added = 0;
  const cursor = new Date(baseDate);
  cursor.setHours(0, 0, 0, 0);

  while (added < Math.max(0, businessDays)) {
    cursor.setDate(cursor.getDate() + 1);
    const weekDay = cursor.getDay();
    if (weekDay !== 0 && weekDay !== 6) {
      added += 1;
    }
  }

  return cursor;
};

const formatDatePtBr = (date: Date) => {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
};

/**
 * Helper para envio automático de mensagens WhatsApp
 */
export class WhatsAppAutoSender {
  static makePublicToken(): string {
    return randomBytes(24).toString('hex');
  }

  static getPublicAppBase(): string {
    return String(process.env.PUBLIC_APP_URL);
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
    const publicUrl = `${this.getPublicAppBase()}/pre-atendimento/documentos/${token}`;

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

      if (params.messageType === 'APPOINTMENT_CONFIRMATION') {
        const normalizedStatus = normalizeStatusKey((appointment as any)?.status);
        if (normalizedStatus.startsWith('CONFIRM')) {
          return { success: false, error: 'Agendamento já está confirmado; confirmação não enviada novamente.' };
        }
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
      const resolvedMessagingConfig = await resolveWhatsAppConfigForBranch(params.branchId, {
        requireActive: true,
        requireCredentials: true,
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

      // Buscar configuração de notificações.
      // Regras finais: para enviar mensagens automáticas,
      // o template precisa estar ativo E o toggle da aba Notificações precisa estar habilitado.
      const notificationConfig = await prisma.whatsAppNotificationConfig.findUnique({
        where: { branchId: params.branchId },
      });

      // Verificar se deve enviar mensagem baseado no tipo
      if (!params.skipNotificationSettings && params.messageType === 'APPOINTMENT_CREATED' && notificationConfig?.sendOnAppointmentCreated !== true) {
        const errorMessage = notificationConfig
          ? 'Envio de mensagem ao criar agendamento está desativado'
          : 'Configuração de notificação não encontrada para esta filial (APPOINTMENT_CREATED)';
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

      if (!params.skipNotificationSettings && params.messageType === 'APPOINTMENT_CONFIRMATION' && notificationConfig?.sendConfirmationEnabled !== true) {
        const errorMessage = notificationConfig
          ? 'Envio de confirmação de agendamento está desativado'
          : 'Configuração de notificação não encontrada para esta filial (APPOINTMENT_CONFIRMATION)';
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
        ...params.customTemplateData,
      };

      const templateBranchPriority = Array.from(new Set([
        String(resolvedMessagingConfig?.sourceBranchId || '').trim(),
        String(params.branchId || '').trim(),
      ].filter(Boolean)));

      // Buscar template de mensagem
      let message: string;
      let templateRecord: Awaited<ReturnType<typeof prisma.whatsAppMessageTemplate.findFirst>> | null = null;
      if (params.customMessage) {
        message = params.customMessage;
      } else {
        const templateCandidates = await prisma.whatsAppMessageTemplate.findMany({
          where: {
            branchId: { in: templateBranchPriority },
            type: params.messageType,
            isActive: true,
          },
          orderBy: [{ updatedAt: 'desc' }],
        });
        templateRecord = templateBranchPriority
          .map((candidateBranchId) => templateCandidates.find((item: any) => item.branchId === candidateBranchId))
          .find(Boolean) || null;

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
        if (params.requireApprovedTemplate && !templateRecord?.hsmTemplateApproved) {
          const errorMessage = 'Template HSM para esta mensagem não está aprovado/ativo na Meta.';
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

      const apiKey = resolvedMessagingConfig?.accountSid;
      const appName = resolvedMessagingConfig?.authToken;
      const sourceNumber = resolvedMessagingConfig?.fromNumber;

      if (!apiKey || !appName || !sourceNumber) {
        const errorMessage = 'WhatsApp não está configurado. Salve as credenciais da filial/empresa.';
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

      const shouldUseConfirmationQuickReply = (
        !params.customMessage
        && params.messageType === 'APPOINTMENT_CONFIRMATION'
      );
      const quickReplyOptions = Array.isArray(params.quickReplyOptions) && params.quickReplyOptions.length > 0
        ? params.quickReplyOptions
        : (shouldUseConfirmationQuickReply
          ? [
              { title: 'Confirmar', postbackText: 'CONFIRM_APPOINTMENT' },
              { title: 'Reagendar', postbackText: 'RESCHEDULE_APPOINTMENT' },
            ]
          : null);

      if (
        (!result || result.status === 'error')
        && quickReplyOptions
        && !params.requireApprovedTemplate
      ) {
        result = await gupshup.sendQuickReplyMessage({
          to: patientPhone,
          body: message,
          msgId: messageLog.id,
          options: quickReplyOptions,
        });

        if (result.status === 'error') {
          console.warn('[whatsapp-auto-sender] quick reply falhou, tentando texto simples:', result.error);
        }
      }

      if ((!result || result.status === 'error') && !params.requireApprovedTemplate) {
        result = await gupshup.sendTextMessage({
          to: patientPhone,
          message,
        });
      }

      if ((!result || result.status === 'error') && params.requireApprovedTemplate) {
        await prisma.whatsAppMessageLog.update({
          where: { id: messageLog.id },
          data: {
            status: 'FAILED',
            errorMessage: result?.error || 'Falha no envio de template HSM obrigatório.',
          },
        });
        return { success: false, error: result?.error || 'Falha no envio de template HSM obrigatório.' };
      }

      if (!result) {
        await prisma.whatsAppMessageLog.update({
          where: { id: messageLog.id },
          data: {
            status: 'FAILED',
            errorMessage: 'Falha ao enviar mensagem para o provedor WhatsApp.',
          },
        });
        return { success: false, error: 'Falha ao enviar mensagem para o provedor WhatsApp.' };
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
    const sourceAppointment = await prisma.appointment.findFirst({
      where: { id: params.appointmentId, branchId: params.branchId },
      select: { date: true, time: true },
    });
    const suggestedDateBase = sourceAppointment?.date
      && /^\d{4}-\d{2}-\d{2}$/.test(String(sourceAppointment.date))
      ? new Date(`${sourceAppointment.date}T00:00:00`)
      : new Date();
    const suggestedDate = addBusinessDays(suggestedDateBase, 7);
    const suggestedDateText = formatDatePtBr(suggestedDate);
    const suggestedTime = isValidTime(sourceAppointment?.time) ? String(sourceAppointment?.time) : '09:00';

    return this.sendMessage({
      branchId: params.branchId,
      appointmentId: params.appointmentId,
      messageType: 'EXAM_REPORT_READY',
      skipNotificationSettings: true,
      requireApprovedTemplate: true,
      customTemplateData: {
        patientName,
        clinicName,
        examName,
        returnDate: suggestedDateText,
        returnTime: suggestedTime,
      },
    });
  }
}

export default WhatsAppAutoSender;


