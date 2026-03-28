import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';
import WhatsAppMessageBuilder from '../lib/whatsapp-message-builder';

export default async function whatsappConfigRoutes(app: FastifyInstance) {
  const ACTIVE_TEMPLATE_TYPES = [
    'APPOINTMENT_CREATED',
    'APPOINTMENT_CONFIRMATION',
    'NO_SHOW',
    'CONFIRMATION_REPLY_CONFIRMED',
    'CONFIRMATION_REPLY_RESCHEDULE',
  ] as const;

  const DEFAULT_TEMPLATES = [
    {
      type: 'APPOINTMENT_CREATED',
      name: 'Resumo de Agendamento',
      hsmTemplateName: 'resumo_agendamento',
      message: 'Olá, {{paciente_nome}}! 😊\nSeu atendimento está confirmado:\n📅 {{data}} às {{hora}}\n👩‍⚕️ {{profissional}}\n📍 {{local}}\n📎 Para agilizar seu atendimento, pedimos que envie seus documentos pelo link abaixo:\n👉 {{link_documentos}}\nEm caso de necessidade, fale conosco por aqui.\n{{clinica_nome}}',
    },
    {
      type: 'APPOINTMENT_CONFIRMATION',
      name: 'Confirmação de Agendamento',
      hsmTemplateName: 'confirmacao_agendamento',
      message: 'Olá, {{paciente_nome}}! 😊\nEstamos entrando em contato para confirmar seu agendamento:\n📅 Data: {{data}}\n⏰ Horário: {{hora}}\n👩‍⚕️ Profissional: {{profissional}}\n📍 Local: {{local}}\nPor favor, escolha uma das opções nos botões abaixo.\nFicamos no aguardo.\n{{clinica_nome}}',
    },
    {
      type: 'CONFIRMATION_REPLY_CONFIRMED',
      name: 'Resposta Confirmado',
      hsmTemplateName: 'resposta_confirmado',
      message: '✅ Agendamento confirmado com sucesso!\n📅 {{data}}\n⏰ {{hora}}\n👩‍⚕️ {{profissional}}\nQualquer imprevisto, fale conosco por este canal.\nAté breve! 💙\n{{clinica_nome}}',
    },
    {
      type: 'CONFIRMATION_REPLY_RESCHEDULE',
      name: 'Resposta Reagendar',
      hsmTemplateName: 'resposta_reagendar',
      message: 'Em breve um atendente entrará em contato para seguir com seu reagendamento.',
    },
    {
      type: 'NO_SHOW',
      name: 'Falta',
      hsmTemplateName: 'falta_agendamento',
      message: 'Olá, {{paciente_nome}}.\nNotamos que você não compareceu ao atendimento agendado:\n📅 {{data}} às {{hora}}\n👩‍⚕️ {{profissional}}\n📍 {{local}}\nCaso tenha ocorrido algum imprevisto, pedimos que nos informe por aqui.\n{{clinica_nome}}',
    },
  ] as const;

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
          appId: { type: 'string', description: 'Gupshup App ID (UUID) — necessário para sincronizar status de templates HSM' },
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
        appId: data.appId || null,
        isActive: data.isActive ?? true,
      },
      update: {
        accountSid: data.accountSid,
        authToken: authTokenToUse,
        fromNumber: data.fromNumber,
        appId: data.appId !== undefined ? (data.appId || null) : undefined,
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
        400: { type: 'object' },
        403: { type: 'object' },
        404: { type: 'object' },
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
      where: {
        branchId,
        type: {
          in: [...ACTIVE_TEMPLATE_TYPES],
        },
      },
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
            enum: [...ACTIVE_TEMPLATE_TYPES],
          },
          name: { type: 'string' },
          message: { type: 'string' },
          hsmTemplateName: { type: 'string', description: 'Nome do template HSM aprovado no Gupshup (ex: confirmacao_agendamento)' },
          isActive: { type: 'boolean' },
        },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        400: { type: 'object', additionalProperties: true },
        403: { type: 'object', additionalProperties: true },
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

    const existingTemplate = await prisma.whatsAppMessageTemplate.findUnique({
      where: {
        branchId_type: {
          branchId,
          type: data.type,
        },
      },
    });

    const nextHsmTemplateName = data.hsmTemplateName !== undefined ? (data.hsmTemplateName || null) : undefined;
    const shouldResetHsmSyncFields =
      nextHsmTemplateName !== undefined
      && existingTemplate
      && (existingTemplate.hsmTemplateName || null) !== nextHsmTemplateName;

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
        hsmTemplateId: null,
        hsmTemplateStatus: null,
        hsmTemplateApproved: false,
        isActive: data.isActive ?? true,
      },
      update: {
        name: data.name,
        message: data.message,
        hsmTemplateName: nextHsmTemplateName,
        ...(shouldResetHsmSyncFields
          ? {
              hsmTemplateId: null,
              hsmTemplateStatus: null,
              hsmTemplateApproved: false,
            }
          : {}),
        isActive: data.isActive,
      },
    });

    return template;
  });

  app.post('/whatsapp/templates/load-defaults', {
    schema: {
      summary: 'Load default WhatsApp templates',
      tags: ['WhatsApp'],
      response: {
        200: { type: 'object' },
        403: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    let created = 0;
    let updated = 0;

    await prisma.whatsAppMessageTemplate.deleteMany({
      where: {
        branchId,
        type: {
          in: ['APPOINTMENT_REMINDER', 'APPOINTMENT_CANCELED'],
        },
      },
    });

    for (const item of DEFAULT_TEMPLATES) {
      const existing = await prisma.whatsAppMessageTemplate.findUnique({
        where: {
          branchId_type: {
            branchId,
            type: item.type as any,
          },
        },
      });

      if (existing) {
        await prisma.whatsAppMessageTemplate.update({
          where: { id: existing.id },
          data: {
            name: item.name,
            message: item.message,
            hsmTemplateName: item.hsmTemplateName,
            isActive: true,
          },
        });
        updated += 1;
      } else {
        await prisma.whatsAppMessageTemplate.create({
          data: {
            branchId,
            type: item.type as any,
            name: item.name,
            message: item.message,
            hsmTemplateName: item.hsmTemplateName,
            isActive: true,
          },
        });
        created += 1;
      }
    }

    return {
      success: true,
      created,
      updated,
      total: DEFAULT_TEMPLATES.length,
    };
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
        400: { type: 'object' },
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

    // Se existir vínculo HSM, exige remover no Gupshup antes de remover local
    if (template.hsmTemplateId || template.hsmTemplateName) {
      const whatsappConfig = await prisma.whatsAppConfig.findUnique({ where: { branchId } });
      const gupshupAppId = whatsappConfig?.appId || process.env.GUPSHUP_APP_ID || '';
      const apiKey = whatsappConfig?.accountSid || process.env.GUPSHUP_API_KEY || '';

      if (!gupshupAppId || !apiKey) {
        return reply.code(400).send({
          error: 'Não foi possível excluir o template no Gupshup: App ID/API Key não configurados.',
        });
      }

      const encodedTemplateId = template.hsmTemplateId ? encodeURIComponent(template.hsmTemplateId) : null;
      const encodedElementName = template.hsmTemplateName ? encodeURIComponent(template.hsmTemplateName) : null;
      const deleteAttempts: string[] = [];

      const candidates: string[] = [
        // Endpoint principal com query params (templateId + elementName)
        `https://api.gupshup.io/wa/app/${encodeURIComponent(gupshupAppId)}/template?${new URLSearchParams({
          ...(template.hsmTemplateId ? { templateId: template.hsmTemplateId } : {}),
          ...(template.hsmTemplateName ? { elementName: template.hsmTemplateName } : {}),
        }).toString()}`,
        // Variação por path com templateId
        ...(encodedTemplateId
          ? [`https://api.gupshup.io/wa/app/${encodeURIComponent(gupshupAppId)}/template/${encodedTemplateId}${encodedElementName ? `?elementName=${encodedElementName}` : ''}`]
          : []),
        // Variação por path com elementName
        ...(encodedElementName
          ? [`https://api.gupshup.io/wa/app/${encodeURIComponent(gupshupAppId)}/template/${encodedElementName}`]
          : []),
      ];

      let deletedInGupshup = false;
      for (const url of candidates) {
        const gupshupRes = await fetch(url, {
          method: 'DELETE',
          headers: { apikey: apiKey },
        });

        const responseBody = await gupshupRes.text();
        const shortBody = responseBody.length > 600 ? `${responseBody.slice(0, 600)}...` : responseBody;
        deleteAttempts.push(`[${gupshupRes.status}] ${url} => ${shortBody}`);

        // 404 significa que já não existe no provedor; podemos seguir com cleanup local
        if (gupshupRes.ok || gupshupRes.status === 404) {
          deletedInGupshup = true;
          break;
        }
      }

      if (!deletedInGupshup) {
        return reply.code(400).send({
          error: 'Falha ao excluir template no Gupshup. O template local não foi removido.',
          details: deleteAttempts,
        });
      }
    }

    await prisma.whatsAppMessageTemplate.delete({ where: { id: template.id } });

    return { success: true };
  });

  // ===== Enviar template para o Gupshup =====

  app.post('/whatsapp/templates/:id/push-to-gupshup', {
    schema: {
      summary: 'Create HSM template in Gupshup via API',
      tags: ['WhatsApp'],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        400: { type: 'object' },
        403: { type: 'object' },
        404: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;

    const template = await prisma.whatsAppMessageTemplate.findFirst({ where: { id, branchId } });
    if (!template) return reply.code(404).send({ error: 'Template não encontrado' });

    if (!template.hsmTemplateName) {
      return reply.code(400).send({
        error: 'Preencha o campo "Nome do Template (Gupshup/Meta HSM)" antes de enviar para o Gupshup.',
      });
    }

    const whatsappConfig = await prisma.whatsAppConfig.findUnique({ where: { branchId } });
    const gupshupAppId = whatsappConfig?.appId || process.env.GUPSHUP_APP_ID || '';
    const apiKey = whatsappConfig?.accountSid || process.env.GUPSHUP_API_KEY || '';

    if (!gupshupAppId || !apiKey) {
      return reply.code(400).send({
        error: 'App ID do Gupshup não configurado. Preencha o campo App ID nas configurações de credenciais.',
      });
    }

    // Converter variáveis nomeadas ({{paciente_nome}}) em numeradas ({{1}}, {{2}}, ...)
    let varIndex = 1;
    const numberedContent = template.message.replace(/\{\{[^}]+\}\}/g, () => `{{${varIndex++}}}`);

    // Montar exemplo com valores fictícios
    const exampleMessage = template.message
      .replace(/\{\{paciente_nome\}\}/gi, 'João Silva')
      .replace(/\{\{paciente_cpf\}\}/gi, '123.456.789-00')
      .replace(/\{\{medico_nome\}\}/gi, 'Dr. Carlos')
      .replace(/\{\{especialidade\}\}/gi, 'Cardiologia')
      .replace(/\{\{data\}\}/gi, '18/03/2026 (Quarta-feira)')
      .replace(/\{\{hora\}\}/gi, '14:00')
      .replace(/\{\{convenio\}\}/gi, 'Plano Saúdy')
      .replace(/\{\{observacoes\}\}/gi, '-')
      .replace(/\{\{profissional\}\}/gi, 'Dra. Mariana Souza')
      .replace(/\{\{local\}\}/gi, 'Clínica Saúdy - Unidade Centro')
      .replace(/\{\{link_documentos\}\}/gi, 'https://saudy.app/documentos')
      .replace(/\{\{clinica_nome\}\}/gi, 'Clínica Saúdy');

    // Regra de categoria para criação de template no Gupshup:
    // - UTILITY para comunicações transacionais de atendimento/agendamento
    // - MARKETING para campanhas/promocionais
    const gupshupCategory =
      template.type === 'APPOINTMENT_CREATED'
      || template.type === 'APPOINTMENT_CONFIRMATION'
      || template.type === 'NO_SHOW'
      || template.type === 'CONFIRMATION_REPLY_CONFIRMED'
      || template.type === 'CONFIRMATION_REPLY_RESCHEDULE'
        ? 'UTILITY'
        : 'MARKETING';

    const body = new URLSearchParams({
      elementName: template.hsmTemplateName,
      languageCode: 'pt_BR',
      content: numberedContent,
      category: gupshupCategory,
      templateType: 'TEXT',
      vertical: 'Healthcare',
      example: exampleMessage,
      enableSample: 'true',
    });

    if (template.type === 'APPOINTMENT_CONFIRMATION') {
      body.append('buttons', JSON.stringify([
        { type: 'QUICK_REPLY', text: 'Confirmar' },
        { type: 'QUICK_REPLY', text: 'Reagendar' },
      ]));
    }

    console.log('[push-to-gupshup] sending body:', body.toString());

    const gupshupRes = await fetch(
      `https://api.gupshup.io/wa/app/${gupshupAppId}/template`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          apikey: apiKey,
        },
        body: body.toString(),
      },
    );

    const rawText = await gupshupRes.text();
    let parsed: any;
    try { parsed = JSON.parse(rawText); } catch { parsed = rawText; }

    if (!gupshupRes.ok) {
      return reply.code(400).send({
        error: `Erro ao criar template no Gupshup (${gupshupRes.status}): ${rawText}`,
        detail: parsed,
      });
    }

    return { success: true, gupshupResponse: parsed };
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

  // ===== Sincronizar status de templates HSM com Gupshup =====

  app.post('/whatsapp/templates/sync-hsm', {
    schema: {
      summary: 'Sync HSM template approval status from Gupshup',
      tags: ['WhatsApp'],
      response: {
        200: { type: 'object', additionalProperties: true },
        400: { type: 'object' },
        403: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const whatsappConfig = await prisma.whatsAppConfig.findUnique({ where: { branchId } });

    const gupshupAppId = whatsappConfig?.appId || process.env.GUPSHUP_APP_ID || '';
    const apiKey = whatsappConfig?.accountSid || process.env.GUPSHUP_API_KEY || '';

    if (!gupshupAppId || !apiKey) {
      return reply.code(400).send({
        error: 'App ID do Gupshup não configurado. Preencha o campo App ID nas configurações.',
      });
    }

    // Buscar templates no Gupshup
    const gupshupRes = await fetch(
      `https://api.gupshup.io/wa/app/${gupshupAppId}/template`,
      { headers: { apikey: apiKey } },
    );

    if (!gupshupRes.ok) {
      const body = await gupshupRes.text();
      return reply.code(400).send({ error: `Erro ao consultar Gupshup: ${body}` });
    }

    const gupshupData = await gupshupRes.json() as { status: string; templates: any[] };
    // Map: elementName (lowercase) -> { status, id }
    const gupshupTemplates: Record<string, { status: string; id: string | null }> = {};
    for (const t of (gupshupData.templates || [])) {
      if (!t.elementName) continue;
      const templateId =
        t.id
        ?? t.templateId
        ?? t.templateID
        ?? t.elementId
        ?? null;
      gupshupTemplates[t.elementName.toLowerCase()] = {
        status: String(t.status || ''),
        id: templateId ? String(templateId) : null,
      };
    }

    // Atualizar templates locais
    const localTemplates = await prisma.whatsAppMessageTemplate.findMany({ where: { branchId } });
    let updated = 0;

    for (const tmpl of localTemplates) {
      if (!tmpl.hsmTemplateName) continue;
      const gupshupTemplate = gupshupTemplates[tmpl.hsmTemplateName.toLowerCase()];
      const gupshupStatus = gupshupTemplate?.status || null;
      const approved = gupshupStatus === 'APPROVED';
      const hsmTemplateId = gupshupTemplate?.id || null;
      const shouldUpdate =
        tmpl.hsmTemplateApproved !== approved
        || (tmpl.hsmTemplateStatus || null) !== gupshupStatus
        || (tmpl.hsmTemplateId || null) !== hsmTemplateId;

      if (shouldUpdate) {
        await prisma.whatsAppMessageTemplate.update({
          where: { id: tmpl.id },
          data: {
            hsmTemplateApproved: approved,
            hsmTemplateStatus: gupshupStatus,
            hsmTemplateId,
          },
        });
        updated++;
      }
    }

    return {
      synced: localTemplates.filter((t: any) => t.hsmTemplateName).length,
      updated,
      gupshupTemplates,
    };
  });

}
