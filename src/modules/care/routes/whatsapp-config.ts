import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../lib/prisma';
import WhatsAppMessageBuilder from '../lib/whatsapp-message-builder';
import { ACTIVE_TEMPLATE_TYPES, DEFAULT_TEMPLATES } from '../lib/whatsapp-default-templates';
import { syncBranchHsmTemplates } from '../lib/whatsapp-hsm-sync';

const hasDatabaseWhatsAppCredentials = (config: any) => Boolean(
  config?.accountSid?.trim()
  && config?.authToken?.trim()
  && config?.fromNumber?.trim(),
);

const GENERATED_HSM_NAME_REGEX = /^[a-z0-9_]+_[0-9a-f]{32}$/;

const normalizeTemplateBaseName = (value: string) => {
  const normalized = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');

  return normalized || 'template_whatsapp';
};

const generateHsmTemplateName = (value: string) => `${normalizeTemplateBaseName(value)}_${uuidv4().replace(/-/g, '')}`;

const validateTemplateBusinessRules = (data: { message?: string; hsmTemplateName?: string | null }) => {
  const message = String(data.message || '').trim();
  const hsmTemplateName = String(data.hsmTemplateName || '').trim();
  const foundVariables = message.match(/\{\{[^}]+\}\}/g) || [];

  if (hsmTemplateName && !GENERATED_HSM_NAME_REGEX.test(hsmTemplateName)) {
    return 'O nome interno do template HSM precisa seguir o formato normalizado com UUID final.';
  }

  if (/^\{\{[^}]+\}\}$/.test(message)) {
    return 'Não é permitido cadastrar uma variável sozinha no conteúdo do template.';
  }

  const lastVariable = foundVariables[foundVariables.length - 1];
  if (lastVariable && message.endsWith(lastVariable)) {
    return 'Não é permitido cadastrar variável no final do template.';
  }

  return null;
};

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
        400: { type: 'object' },
        403: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const whatsappConfig = await prisma.whatsAppConfig.findUnique({ where: { branchId } });
    if (!hasDatabaseWhatsAppCredentials(whatsappConfig)) {
      return reply.code(400).send({
        error: 'Credenciais do WhatsApp não configuradas para esta filial. Acesse Configurações para salvar a credencial no banco.',
      });
    }

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
          id: { type: 'string' },
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
        404: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;
    const whatsappConfig = await prisma.whatsAppConfig.findUnique({ where: { branchId } });
    if (!hasDatabaseWhatsAppCredentials(whatsappConfig)) {
      return reply.code(400).send({
        error: 'Credenciais do WhatsApp não configuradas para esta filial. Salve a credencial no banco antes de editar templates.',
      });
    }

    // Validar template
    const validation = WhatsAppMessageBuilder.validateTemplate(data.message);
    if (!validation.valid) {
      return reply.code(400).send({
        error: 'Template contém variáveis inválidas',
        invalidVariables: validation.invalidVariables,
        availableVariables: WhatsAppMessageBuilder.getAvailableVariables(),
      });
    }

    const businessValidationError = validateTemplateBusinessRules(data);
    if (businessValidationError) {
      return reply.code(400).send({ error: businessValidationError });
    }

    const existingTemplate = await prisma.whatsAppMessageTemplate.findUnique({
      where: {
        branchId_type: {
          branchId,
          type: data.type,
        },
      },
    });

    if (data.id) {
      if (!existingTemplate || existingTemplate.id !== data.id) {
        return reply.code(404).send({ error: 'Template não encontrado para edição.' });
      }
    } else if (existingTemplate) {
      return reply.code(400).send({
        error: `Já existe um template do tipo "${data.type}" cadastrado para esta filial.`,
      });
    }

    const normalizedName = String(data.name || '').trim();
    const shouldRegenerateHsmTemplateName =
      !existingTemplate
      || !existingTemplate.hsmTemplateName
      || String(existingTemplate.name || '').trim() !== normalizedName;

    const nextHsmTemplateName = shouldRegenerateHsmTemplateName
      ? generateHsmTemplateName(normalizedName)
      : (existingTemplate?.hsmTemplateName || null);

    const shouldResetHsmSyncFields =
      existingTemplate
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
        hsmTemplateName: nextHsmTemplateName,
        hsmTemplateId: null,
        hsmTemplateStatus: null,
        hsmTemplateApproved: false,
        importedFromGupshupSync: false,
        isActive: data.isActive ?? false,
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
        400: { type: 'object' },
        403: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const whatsappConfig = await prisma.whatsAppConfig.findUnique({ where: { branchId } });
    if (!hasDatabaseWhatsAppCredentials(whatsappConfig)) {
      return reply.code(400).send({
        error: 'Credenciais do WhatsApp não configuradas para esta filial. Salve a credencial no banco antes de carregar templates.',
      });
    }

    let created = 0;
    let updated = 0;
    const createdTypes: string[] = [];

    await prisma.whatsAppMessageTemplate.deleteMany({
      where: {
        branchId,
        type: {
          in: ['APPOINTMENT_REMINDER', 'EXAM_REPORT_READY', 'APPOINTMENT_CANCELED'],
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
        const nextHsmTemplateName = existing.hsmTemplateName || generateHsmTemplateName(item.name);
        await prisma.whatsAppMessageTemplate.update({
          where: { id: existing.id },
          data: {
            name: item.name,
            message: item.message,
            hsmTemplateName: nextHsmTemplateName,
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
            hsmTemplateName: generateHsmTemplateName(item.name),
            importedFromGupshupSync: false,
            isActive: false,
          },
        });
        createdTypes.push(String(item.type));
        created += 1;
      }
    }

    let syncResult: any = null;
    try {
      syncResult = await syncBranchHsmTemplates(branchId);
    } catch (error) {
      // Não bloqueia o carregamento dos defaults quando a sincronização remota falhar.
      console.error('[whatsapp-load-defaults] sync-hsm failed:', error);
    }

    if (createdTypes.length > 0) {
      await prisma.whatsAppMessageTemplate.updateMany({
        where: {
          branchId,
          type: { in: createdTypes as any[] },
          hsmTemplateApproved: true,
          isActive: false,
        },
        data: {
          isActive: true,
        },
      });
    }

    return {
      success: true,
      created,
      updated,
      total: DEFAULT_TEMPLATES.length,
      sync: syncResult
        ? {
            synced: Number(syncResult.synced || 0),
            updated: Number(syncResult.updated || 0),
          }
        : null,
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
        400: { type: 'object' },
        403: { type: 'object' },
        404: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const whatsappConfig = await prisma.whatsAppConfig.findUnique({ where: { branchId } });
    if (!hasDatabaseWhatsAppCredentials(whatsappConfig)) {
      return reply.code(400).send({
        error: 'Credenciais do WhatsApp não configuradas para esta filial. Salve a credencial no banco antes de acessar templates.',
      });
    }

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

    const whatsappConfig = await prisma.whatsAppConfig.findUnique({ where: { branchId } });
    const { id } = request.params as any;

    const template = await prisma.whatsAppMessageTemplate.findFirst({
      where: { id, branchId },
    });

    if (!template) {
      return reply.code(404).send({ error: 'Template not found' });
    }

    // Se existir vínculo HSM, tentamos remover no Gupshup apenas quando ele realmente existir lá.
    if (template.hsmTemplateId || template.hsmTemplateName) {
      const gupshupAppId = whatsappConfig?.appId || '';
      const apiKey = whatsappConfig?.accountSid || '';
      const hasRemoteSignals = Boolean(
        template.hsmTemplateId
        || template.hsmTemplateStatus
        || template.importedFromGupshupSync,
      );

      if (gupshupAppId && apiKey) {
        const listRes = await fetch(
          `https://api.gupshup.io/wa/app/${encodeURIComponent(gupshupAppId)}/template`,
          { headers: { apikey: apiKey } },
        );

        if (listRes.ok) {
          const listData = await listRes.json() as { templates?: any[] };
          const remoteTemplate = (listData.templates || []).find((item: any) => {
            const remoteId = String(item?.id ?? item?.templateId ?? item?.templateID ?? item?.elementId ?? '').trim();
            const remoteName = String(item?.elementName || '').trim().toLowerCase();
            return (
              (template.hsmTemplateId && remoteId === template.hsmTemplateId)
              || (template.hsmTemplateName && remoteName === String(template.hsmTemplateName).trim().toLowerCase())
            );
          });

          if (remoteTemplate) {
            const remoteTemplateId = String(
              remoteTemplate?.id
              ?? remoteTemplate?.templateId
              ?? remoteTemplate?.templateID
              ?? remoteTemplate?.elementId
              ?? '',
            ).trim();
            const remoteElementName = String(remoteTemplate?.elementName || template.hsmTemplateName || '').trim();
            const encodedTemplateId = remoteTemplateId ? encodeURIComponent(remoteTemplateId) : null;
            const encodedElementName = remoteElementName ? encodeURIComponent(remoteElementName) : null;
            const deleteAttempts: string[] = [];
            const candidates: string[] = [
              `https://api.gupshup.io/wa/app/${encodeURIComponent(gupshupAppId)}/template?${new URLSearchParams({
                ...(remoteTemplateId ? { templateId: remoteTemplateId } : {}),
                ...(remoteElementName ? { elementName: remoteElementName } : {}),
              }).toString()}`,
              ...(encodedTemplateId
                ? [`https://api.gupshup.io/wa/app/${encodeURIComponent(gupshupAppId)}/template/${encodedTemplateId}${encodedElementName ? `?elementName=${encodedElementName}` : ''}`]
                : []),
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
        } else if (hasRemoteSignals) {
          const body = await listRes.text();
          return reply.code(400).send({
            error: 'Falha ao verificar a existência do template no Gupshup antes da exclusão.',
            details: body,
          });
        }
      } else if (hasRemoteSignals) {
        return reply.code(400).send({
          error: 'Não foi possível confirmar a exclusão no Gupshup porque a filial não possui App ID/API Key configurados.',
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

    const currentTemplate = await prisma.whatsAppMessageTemplate.findFirst({ where: { id, branchId } });
    if (!currentTemplate) return reply.code(404).send({ error: 'Template não encontrado' });

    let template = currentTemplate;
    if (!template.hsmTemplateName || !GENERATED_HSM_NAME_REGEX.test(template.hsmTemplateName)) {
      template = await prisma.whatsAppMessageTemplate.update({
        where: { id: currentTemplate.id },
        data: {
          hsmTemplateName: generateHsmTemplateName(currentTemplate.name),
          hsmTemplateId: null,
          hsmTemplateStatus: null,
          hsmTemplateApproved: false,
        },
      });
    }

    if (!template.hsmTemplateName) {
      return reply.code(400).send({
        error: 'O nome interno do template HSM não foi gerado corretamente. Salve o template novamente antes de enviar para o Gupshup.',
      });
    }

    const whatsappConfig = await prisma.whatsAppConfig.findUnique({ where: { branchId } });
    const gupshupAppId = whatsappConfig?.appId;
    const apiKey = whatsappConfig?.accountSid;

    if (!gupshupAppId || !apiKey) {
      return reply.code(400).send({
        error: 'App ID do Gupshup não configurado. Preencha o campo App ID nas configurações de credenciais.',
      });
    }

    // Converter variáveis nomeadas ({{paciente_nome}}) em numeradas ({{1}}, {{2}}, ...)
    let varIndex = 1;
    const numberedContent = template.message.replace(/\{\{[^}]+\}\}/g, () => `{{${varIndex++}}}`);

    // Mantemos o formato antigo que já funcionava neste projeto ao enviar o template.
    const exampleMessage = template.message
      .replace(/\{\{paciente_nome\}\}/gi, 'João Silva')
      .replace(/\{\{paciente_cpf\}\}/gi, '123.456.789-00')
      .replace(/\{\{medico_nome\}\}/gi, 'Dr. Carlos')
      .replace(/\{\{especialidade\}\}/gi, 'Cardiologia')
      .replace(/\{\{exame_nome\}\}/gi, 'Tomografia')
      .replace(/\{\{retorno_data\}\}/gi, '25/04/2026')
      .replace(/\{\{retorno_hora\}\}/gi, '09:00')
      .replace(/\{\{data\}\}/gi, '18/03/2026 (Quarta-feira)')
      .replace(/\{\{hora\}\}/gi, '14:00')
      .replace(/\{\{convenio\}\}/gi, 'Plano Saúdy')
      .replace(/\{\{observacoes\}\}/gi, '-');

    const body = new URLSearchParams({
      elementName: template.hsmTemplateName,
      languageCode: 'pt_BR',
      content: numberedContent,
      category: 'UTILITY',
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

    if (template.type === 'EXAM_REPORT_READY') {
      body.append('buttons', JSON.stringify([
        { type: 'QUICK_REPLY', text: 'Agendar retorno' },
        { type: 'QUICK_REPLY', text: 'Depois' },
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
      console.error('[push-to-gupshup] error response:', gupshupRes.status, parsed);
      const providerMessage =
        parsed?.message
        || parsed?.error
        || parsed?.details
        || parsed?.detail
        || rawText;

      return reply.code(400).send({
        error: `Erro ao criar template no Gupshup (${gupshupRes.status}): ${providerMessage}`,
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
        400: { type: 'object' },
        403: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const whatsappConfig = await prisma.whatsAppConfig.findUnique({ where: { branchId } });
    if (!hasDatabaseWhatsAppCredentials(whatsappConfig)) {
      return reply.code(400).send({
        error: 'Credenciais do WhatsApp não configuradas para esta filial. Salve a credencial no banco antes de editar notificações.',
      });
    }

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
        400: { type: 'object' },
        403: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const whatsappConfig = await prisma.whatsAppConfig.findUnique({ where: { branchId } });
    if (!hasDatabaseWhatsAppCredentials(whatsappConfig)) {
      return reply.code(400).send({
        error: 'Credenciais do WhatsApp não configuradas para esta filial. Salve a credencial no banco antes de editar notificações.',
      });
    }

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
    try {
      return await syncBranchHsmTemplates(branchId);
    } catch (error: any) {
      return reply.code(400).send({ error: error.message || 'Erro ao sincronizar templates HSM' });
    }
  });

}
