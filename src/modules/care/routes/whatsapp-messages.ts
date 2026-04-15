import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';
import GupshupService, { SendMessageResponse } from '../lib/gupshup';
import WhatsAppMessageBuilder, { AppointmentData } from '../lib/whatsapp-message-builder';
import { resolveWhatsAppConfigForBranch } from '../lib/whatsapp-config-resolver';

type WhatsAppMessageType =
  | 'APPOINTMENT_CREATED'
  | 'APPOINTMENT_CONFIRMATION'
  | 'NO_SHOW'
  | 'CONFIRMATION_REPLY_CONFIRMED'
  | 'CONFIRMATION_REPLY_RESCHEDULE';

export default async function whatsappMessagesRoutes(app: FastifyInstance) {
  const getLoggedBranchId = async (request: any) => {
    const userId = (request.user as any)?.id;
    if (!userId) return null;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });
    return user?.sector?.branch?.id || null;
  };

  app.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });
  
  // ===== Send Message =====
  
  app.post('/whatsapp/send', {
    schema: {
      summary: 'Send WhatsApp message',
      tags: ['WhatsApp'],
      body: {
        type: 'object',
        required: ['appointmentId', 'messageType'],
        properties: {
          appointmentId: { type: 'string' },
          messageType: {
            type: 'string',
            enum: [
              'APPOINTMENT_CREATED',
              'APPOINTMENT_CONFIRMATION',
              'NO_SHOW',
              'CONFIRMATION_REPLY_CONFIRMED',
              'CONFIRMATION_REPLY_RESCHEDULE',
            ],
          },
          customMessage: { type: 'string' },
        },
      },
      response: {
        200: { type: 'object' },
        400: { type: 'object' },
        403: { type: 'object' },
        404: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;

    try {
      // Buscar agendamento
      const appointment = await prisma.appointment.findFirst({
        where: { id: data.appointmentId, branchId },
      });

      if (!appointment) {
        return reply.code(404).send({ error: 'Agendamento não encontrado' });
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
        return reply.code(400).send({ 
          error: 'Paciente não possui telefone cadastrado',
          appointmentId: appointment.id,
        });
      }

      const branch = await prisma.branch.findUnique({
        where: { id: branchId },
        select: { tradeName: true, address: true },
      });

      // Buscar configuração do WhatsApp
      const whatsappConfig = await prisma.whatsAppConfig.findUnique({ where: { branchId } });
      const resolvedMessagingConfig = await resolveWhatsAppConfigForBranch(branchId, {
        requireActive: true,
        requireCredentials: true,
      });

      if (!resolvedMessagingConfig) {
        return reply.code(400).send({ error: 'WhatsApp não está configurado para esta filial/empresa' });
      }

      if (whatsappConfig && !whatsappConfig.isActive && !resolvedMessagingConfig.isInherited) {
        return reply.code(400).send({ error: 'WhatsApp está desativado para esta filial' });
      }

      const apiKey     = resolvedMessagingConfig.accountSid;
      const appName    = resolvedMessagingConfig.authToken;
      const fromNumber = resolvedMessagingConfig.fromNumber;
      const templateBranchPriority = Array.from(new Set([
        String(resolvedMessagingConfig.sourceBranchId || '').trim(),
        String(branchId || '').trim(),
      ].filter(Boolean)));

      // Buscar template de mensagem ou usar mensagem customizada
      let message: string;
      if (data.customMessage) {
        message = data.customMessage;
      } else {
        const templateCandidates = await prisma.whatsAppMessageTemplate.findMany({
          where: {
            branchId: { in: templateBranchPriority },
            type: data.messageType,
            isActive: true,
          },
          orderBy: [{ updatedAt: 'desc' }],
        });
        const template = templateBranchPriority
          .map((candidateBranchId) => templateCandidates.find((item: any) => item.branchId === candidateBranchId))
          .find(Boolean) || null;

        if (!template) {
          return reply.code(400).send({ 
            error: 'Template de mensagem não encontrado',
            messageType: data.messageType,
          });
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
          clinicName: branch?.tradeName || '',
          location: branch?.tradeName || branch?.address || '',
          professional: appointment.doctorName || '',
          documentsLink: '',
        };

        message = WhatsAppMessageBuilder.buildMessage(template.message, appointmentData);
      }

      // Criar log antes de enviar
      const messageLog = await prisma.whatsAppMessageLog.create({
        data: {
          branchId,
          appointmentId: appointment.id,
          patientName: appointment.patientName,
          patientPhone,
          messageType: data.messageType,
          message,
          status: 'PENDING',
        },
      });

      // Enviar mensagem via Gupshup
      const gupshup = new GupshupService({
        apiKey: apiKey,
        appName: appName,
        sourceNumber: fromNumber,
      });

      // Tenta HSM template se configurado (funciona sem sessão ativa)
      // Se HSM falhar, cai para session text message
      let result: SendMessageResponse | undefined;
      const templateCandidates = data.customMessage
        ? []
        : await prisma.whatsAppMessageTemplate.findMany({
            where: { branchId: { in: templateBranchPriority }, type: data.messageType, isActive: true },
            orderBy: [{ updatedAt: 'desc' }],
          });
      const templateRecord = data.customMessage
        ? null
        : templateBranchPriority
            .map((candidateBranchId) => templateCandidates.find((item: any) => item.branchId === candidateBranchId))
            .find(Boolean) || null;

      if (
        (!result || result.status === 'error')
        && (templateRecord?.hsmTemplateId || templateRecord?.hsmTemplateName)
        && !data.customMessage
      ) {
        const hsmParams = WhatsAppMessageBuilder.extractTemplateParams(templateRecord.message, {
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
          documentsLink: '',
        });
        result = await gupshup.sendTemplateMessage({
          to: patientPhone,
          templateId: templateRecord.hsmTemplateId || templateRecord.hsmTemplateName!,
          params: hsmParams,
        });
        if (result.status === 'error') {
          console.warn('[whatsapp-send] HSM template falhou:', result.error);
        }
      }

      if ((!result || result.status === 'error') && !data.customMessage && data.messageType === 'APPOINTMENT_CONFIRMATION') {
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
          console.warn('[whatsapp-send] quick reply falhou, tentando texto simples:', result.error);
        }
      }

      if (!result || result.status === 'error') {
        result = await gupshup.sendTextMessage({ to: patientPhone, message });
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

        return {
          success: true,
          messageId: result.messageId,
          logId: messageLog.id,
        };
      } else {
        await prisma.whatsAppMessageLog.update({
          where: { id: messageLog.id },
          data: {
            status: 'FAILED',
            errorMessage: result.error,
          },
        });

        return reply.code(400).send({
          error: 'Falha ao enviar mensagem',
          details: result.error,
        });
      }
    } catch (error: any) {
      request.log.error({ err: error }, 'Failed to send WhatsApp message');
      return reply.code(400).send({
        error: 'Erro ao enviar mensagem WhatsApp',
        details: error.message,
      });
    }
  });

  // ===== Message Logs =====

  app.get('/whatsapp/logs', {
    schema: {
      summary: 'List WhatsApp message logs',
      tags: ['WhatsApp'],
      querystring: {
        type: 'object',
        properties: {
          appointmentId: { type: 'string' },
          status: { type: 'string' },
          messageType: { type: 'string' },
          limit: { type: 'integer', default: 50 },
          offset: { type: 'integer', default: 0 },
        },
      },
      response: {
        200: { type: 'object' },
        403: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const query = request.query as any;
    const limit = Number(query.limit) || 50;
    const offset = Number(query.offset) || 0;

    const currentBranch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { companyId: true },
    });

    let scopedBranchIds = [branchId];
    if (currentBranch?.companyId) {
      const companyBranches = await prisma.branch.findMany({
        where: { companyId: currentBranch.companyId },
        select: { id: true },
      });
      const branchIds = companyBranches.map((item: { id: string }) => String(item.id || '').trim()).filter(Boolean);
      if (branchIds.length > 0) scopedBranchIds = branchIds;
    }

    const where: any = {
      branchId: { in: scopedBranchIds },
    };
    if (query.appointmentId) where.appointmentId = query.appointmentId;
    if (query.status) where.status = query.status;
    if (query.messageType) where.messageType = query.messageType;

    const [items, total] = await Promise.all([
      prisma.whatsAppMessageLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.whatsAppMessageLog.count({ where }),
    ]);

    return {
      items,
      total,
      limit,
      offset,
    };
  });

  app.get('/whatsapp/logs/:id', {
    schema: {
      summary: 'Get WhatsApp message log',
      tags: ['WhatsApp'],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      response: {
        200: { type: 'object' },
        403: { type: 'object' },
        404: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;

    const currentBranch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { companyId: true },
    });

    let scopedBranchIds = [branchId];
    if (currentBranch?.companyId) {
      const companyBranches = await prisma.branch.findMany({
        where: { companyId: currentBranch.companyId },
        select: { id: true },
      });
      const branchIds = companyBranches.map((item: { id: string }) => String(item.id || '').trim()).filter(Boolean);
      if (branchIds.length > 0) scopedBranchIds = branchIds;
    }

    const log = await prisma.whatsAppMessageLog.findFirst({
      where: { id, branchId: { in: scopedBranchIds } },
    });

    if (!log) {
      return reply.code(404).send({ error: 'Log não encontrado' });
    }

    return log;
  });

  // ===== Test Message =====

  app.post('/whatsapp/test', {
    schema: {
      summary: 'Send test WhatsApp message',
      tags: ['WhatsApp'],
      body: {
        type: 'object',
        required: ['phone', 'message'],
        properties: {
          phone: { type: 'string' },
          message: { type: 'string' },
        },
      },
      response: {
        200: { type: 'object' },
        400: { type: 'object' },
        403: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;

    try {
      const whatsappConfig = await prisma.whatsAppConfig.findUnique({ where: { branchId } });
      const resolvedMessagingConfig = await resolveWhatsAppConfigForBranch(branchId, {
        requireActive: true,
        requireCredentials: true,
      });

      const apiKey     = resolvedMessagingConfig?.accountSid;
      const appName    = resolvedMessagingConfig?.authToken;
      const fromNumber = resolvedMessagingConfig?.fromNumber;

      if (!apiKey || !appName || !fromNumber) {
        return reply.code(400).send({
          error: 'Gupshup não configurado. Configure em Configurações > WhatsApp (filial ou empresa).',
        });
      }

      if (whatsappConfig && !whatsappConfig.isActive && !resolvedMessagingConfig?.isInherited) {
        return reply.code(400).send({ error: 'WhatsApp está desativado para esta filial' });
      }

      const gupshup = new GupshupService({ apiKey, appName, sourceNumber: fromNumber });

      const result = await gupshup.sendTextMessage({
        to: data.phone,
        message: data.message,
      });

      if (result.status === 'success') {
        return {
          success: true,
          messageId: result.messageId,
        };
      } else {
        let errorMessage = result.error || 'Falha ao enviar mensagem de teste';
        let hint = '';
        
        // Adicionar dicas baseadas no erro
        if (result.error?.includes('401')) {
          hint = ' | Dica: Verifique se a API Key está correta.';
        } else if (result.error?.includes('403') || result.error?.includes('Invalid source')) {
          hint = ' | Dica: Verifique se o número de origem está aprovado no Gupshup.';
        } else if (result.error?.includes('Invalid destination') || result.error?.includes('phone number')) {
          hint = ' | Dica: Verifique o formato do número de telefone.';
        } else if (result.error?.includes('RATE_LIMIT')) {
          hint = ' | Limite de envio atingido. Tente novamente mais tarde.';
        }
        
        return reply.code(400).send({
          error: errorMessage + hint,
          gupshupError: result.error,
          config: {
            fromNumber: fromNumber ? '***' + fromNumber.slice(-4) : null,
            apiKey: apiKey ? '***' + apiKey.slice(-4) : null,
          },
        });
      }
    } catch (error: any) {
      request.log.error({ err: error }, 'Failed to send test WhatsApp message');
      return reply.code(400).send({
        error: 'Erro ao enviar mensagem de teste',
        details: error.message,
      });
    }
  });

  // ===== Preview Message =====

  app.post('/whatsapp/preview', {
    schema: {
      summary: 'Preview message with appointment data',
      tags: ['WhatsApp'],
      body: {
        type: 'object',
        required: ['appointmentId', 'template'],
        properties: {
          appointmentId: { type: 'string' },
          template: { type: 'string' },
        },
      },
      response: {
        200: { type: 'object' },
        403: { type: 'object' },
        404: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;

    const appointment = await prisma.appointment.findFirst({
      where: { id: data.appointmentId, branchId },
    });

    if (!appointment) {
      return reply.code(404).send({ error: 'Agendamento não encontrado' });
    }

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { tradeName: true, address: true },
    });

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
      documentsLink: '',
    };

    const previewMessage = WhatsAppMessageBuilder.buildMessage(data.template, appointmentData);

    return {
      preview: previewMessage,
      appointmentData,
    };
  });
}
