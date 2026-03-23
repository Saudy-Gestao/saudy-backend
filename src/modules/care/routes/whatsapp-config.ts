import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';
import WhatsAppMessageBuilder from '../lib/whatsapp-message-builder';

export default async function whatsappConfigRoutes(app: FastifyInstance) {
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
  
  // ===== WhatsApp Config =====
  
  app.get('/whatsapp/config', {
    schema: {
      summary: 'Get WhatsApp config',
      tags: ['WhatsApp'],
      response: {
        200: { 
          type: 'object',
          additionalProperties: true,
        },
        403: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const config = await prisma.whatsAppConfig.findUnique({ where: { branchId } });
    
    // Não retornar authToken (App Name Gupshup) completo por segurança
    // Nota: accountSid = API Key, authToken = App Name, fromNumber = Source Number (Gupshup)
    if (config) {
      return {
        ...config,
        authToken: config.authToken ? '***' + config.authToken.slice(-4) : null,
      };
    }

    return null;
  });

  app.post('/whatsapp/config', {
    schema: {
      summary: 'Create or update WhatsApp config',
      tags: ['WhatsApp'],
      body: {
        type: 'object',
        required: ['accountSid', 'fromNumber'],
        properties: {
          accountSid: { type: 'string', description: 'Gupshup API Key' },
          authToken: { type: 'string', description: 'Gupshup App Name' },
          fromNumber: { type: 'string', description: 'Gupshup Source Number (ex: 5511999999999)' },
          isActive: { type: 'boolean' },
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

    // Verificar se já existe config
    const existingConfig = await prisma.whatsAppConfig.findUnique({
      where: { branchId },
    });

    // Se authToken (App Name Gupshup) não foi enviado e já existe config, manter o anterior
    const authTokenToUse = data.authToken || existingConfig?.authToken;

    if (!authTokenToUse) {
      return reply.code(400).send({ error: 'App Name (authToken) é obrigatório para primeira configuração' });
    }

    const config = await prisma.whatsAppConfig.upsert({
      where: { branchId },
      create: {
        branchId,
        accountSid: data.accountSid,
        authToken: authTokenToUse,
        fromNumber: data.fromNumber,
        isActive: data.isActive ?? true,
      },
      update: {
        accountSid: data.accountSid,
        authToken: authTokenToUse,
        fromNumber: data.fromNumber,
        isActive: data.isActive,
      },
    });

    return {
      ...config,
      authToken: config.authToken ? '***' + config.authToken.slice(-4) : null,
    };
  });

  app.delete('/whatsapp/config', {
    schema: {
      summary: 'Delete WhatsApp config',
      tags: ['WhatsApp'],
      response: {
        200: { type: 'object' },
        403: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    await prisma.whatsAppConfig.delete({ where: { branchId } });
    return { success: true };
  });

  // ===== Message Templates =====

  app.get('/whatsapp/templates', {
    schema: {
      summary: 'List message templates',
      tags: ['WhatsApp'],
      response: {
        200: { type: 'array' },
        403: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const templates = await prisma.whatsAppMessageTemplate.findMany({
      where: { branchId },
      orderBy: { type: 'asc' },
    });

    return templates;
  });

  app.post('/whatsapp/templates', {
    schema: {
      summary: 'Create or update message template',
      tags: ['WhatsApp'],
      body: {
        type: 'object',
        required: ['type', 'name', 'message'],
        properties: {
          type: { 
            type: 'string',
            enum: ['APPOINTMENT_CREATED', 'APPOINTMENT_CONFIRMATION', 'APPOINTMENT_REMINDER', 'APPOINTMENT_CANCELED'],
          },
          name: { type: 'string' },
          message: { type: 'string' },
          hsmTemplateName: { type: 'string', description: 'Nome do template HSM aprovado no Gupshup (ex: confirmacao_agendamento)' },
          isActive: { type: 'boolean' },
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

    // Validar template
    const validation = WhatsAppMessageBuilder.validateTemplate(data.message);
    if (!validation.valid) {
      return reply.code(400).send({
        error: 'Template contém variáveis inválidas',
        invalidVariables: validation.invalidVariables,
        availableVariables: WhatsAppMessageBuilder.getAvailableVariables(),
      });
    }

    const template = await prisma.whatsAppMessageTemplate.upsert({
      where: {
        branchId_type: {
          branchId,
          type: data.type,
        },
      },
      create: {
        branchId,
        type: data.type,
        name: data.name,
        message: data.message,
        hsmTemplateName: data.hsmTemplateName || null,
        isActive: data.isActive ?? true,
      },
      update: {
        name: data.name,
        message: data.message,
        hsmTemplateName: data.hsmTemplateName !== undefined ? (data.hsmTemplateName || null) : undefined,
        isActive: data.isActive,
      },
    });

    return template;
  });

  app.get('/whatsapp/templates/:id', {
    schema: {
      summary: 'Get message template',
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
    
    const template = await prisma.whatsAppMessageTemplate.findFirst({
      where: { id, branchId },
    });

    if (!template) {
      return reply.code(404).send({ error: 'Template not found' });
    }

    return template;
  });

  app.delete('/whatsapp/templates/:id', {
    schema: {
      summary: 'Delete message template',
      tags: ['WhatsApp'],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      response: {
        200: { type: 'object' },
        403: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;

    await prisma.whatsAppMessageTemplate.deleteMany({
      where: { id, branchId },
    });

    return { success: true };
  });

  // ===== Notification Config =====

  app.get('/whatsapp/notification-config', {
    schema: {
      summary: 'Get notification configuration',
      tags: ['WhatsApp'],
      response: {
        200: { 
          type: 'object',
          additionalProperties: true,
        },
        403: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const config = await prisma.whatsAppNotificationConfig.findUnique({ where: { branchId } });
    return config;
  });

  app.post('/whatsapp/notification-config', {
    schema: {
      summary: 'Create or update notification configuration',
      tags: ['WhatsApp'],
      body: {
        type: 'object',
        properties: {
          sendOnAppointmentCreated: { type: 'boolean' },
          sendConfirmationEnabled: { type: 'boolean' },
          confirmationHoursBefore: { type: 'integer', minimum: 1, maximum: 168 },
          sendReminderEnabled: { type: 'boolean' },
          reminderHoursBefore: { type: 'integer', minimum: 1, maximum: 72 },
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

    const data = request.body as any;

    const config = await prisma.whatsAppNotificationConfig.upsert({
      where: { branchId },
      create: {
        branchId,
        sendOnAppointmentCreated: data.sendOnAppointmentCreated ?? true,
        sendConfirmationEnabled: data.sendConfirmationEnabled ?? true,
        confirmationHoursBefore: data.confirmationHoursBefore ?? 24,
        sendReminderEnabled: data.sendReminderEnabled ?? false,
        reminderHoursBefore: data.reminderHoursBefore ?? 2,
      },
      update: {
        sendOnAppointmentCreated: data.sendOnAppointmentCreated,
        sendConfirmationEnabled: data.sendConfirmationEnabled,
        confirmationHoursBefore: data.confirmationHoursBefore,
        sendReminderEnabled: data.sendReminderEnabled,
        reminderHoursBefore: data.reminderHoursBefore,
      },
    });

    return config;
  });

  // ===== Helper endpoint para listar variáveis disponíveis =====

  app.get('/whatsapp/available-variables', {
    schema: {
      summary: 'Get available template variables',
      tags: ['WhatsApp'],
      response: {
        200: { type: 'array' },
      },
    },
  }, async (request, reply) => {
    return WhatsAppMessageBuilder.getAvailableVariables();
  });

}
