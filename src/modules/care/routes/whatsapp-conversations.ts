import { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma';
import { createMessagingService } from '../lib/messaging';
import { HUMAN_FLOWS } from '../lib/whatsapp-chatbot';

const normalizeOptionalString = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const normalizePhone = (value: unknown) => String(value || '').replace(/\D/g, '');
const normalizeProtocolNumber = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const HUMAN_STATUSES = ['QUEUED', 'ASSIGNED', 'CLOSED'] as const;

type HumanStatus = (typeof HUMAN_STATUSES)[number];

type WhatsAppConversationTemplateRow = {
  id: string;
  companyId: string;
  createdByUserId: string | null;
  createdByName: string | null;
  name: string;
  text: string;
  createdAt: Date;
  updatedAt: Date;
};

const normalizeHumanStatus = (value: unknown): HumanStatus | 'ALL' => {
  if (typeof value !== 'string') return 'ALL';
  const normalized = value.trim().toUpperCase();
  if (normalized === 'ALL') return 'ALL';
  return HUMAN_STATUSES.includes(normalized as HumanStatus) ? normalized as HumanStatus : 'ALL';
};

const buildOperatorSignature = (message: string, operatorName: string) => {
  const trimmed = String(message || '').trim();
  const name = String(operatorName || 'Atendente').trim() || 'Atendente';
  return `${trimmed}\n\nAtendimento: ${name}`;
};

const buildOperatorGreeting = (operatorName: string) => {
  const hour = new Date().getHours();
  const period = (hour >= 5 && hour < 12) ? 'Bom dia' : (hour >= 12 && hour < 18) ? 'Boa tarde' : 'Boa noite';
  return `${period}. Como posso ajudar?\n\nAtendimento: ${operatorName}`;
};

const buildTransferMessage = (operatorName: string) => (
  `Estamos realizando uma alteração no seu atendimento. A partir de agora, ${operatorName} seguirá com você.\n\nAtendimento: ${operatorName}`
);

const buildComparableSlot = (date?: string | null, time?: string | null) => {
  const normalizedDate = String(date || '').trim();
  const normalizedTime = String(time || '').trim();
  if (!normalizedDate) return '';
  return `${normalizedDate} ${normalizedTime || '00:00'}`;
};

const extractProtocolTagFromText = (message: string): string | null => {
  const normalizedMessage = String(message || '').trim();
  if (!normalizedMessage) return null;
  const match = normalizedMessage.match(/\[Protocolo\s+([^\]]+)\]/i);
  return match?.[1]?.trim() || null;
};

const extractProtocolFromMetadata = (metadata: unknown): string | null => {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = String((metadata as any)?.protocolNumber || '').trim();
  return value || null;
};

const resolveMessageProtocolNumber = (item: any): string | null => (
  extractProtocolFromMetadata(item?.metadata) || extractProtocolTagFromText(String(item?.message || ''))
);

const sliceMessagesByProtocol = (items: any[], protocolNumber: string): any[] => {
  const target = normalizeProtocolNumber(protocolNumber);
  if (!target) return items;

  const firstTaggedIndex = items.findIndex((item) => resolveMessageProtocolNumber(item) === target);
  if (firstTaggedIndex < 0) {
    return items.filter((item) => extractProtocolFromMetadata(item?.metadata) === target);
  }

  const nextProtocolIndex = items.findIndex((item, index) => {
    if (index <= firstTaggedIndex) return false;
    const protocol = resolveMessageProtocolNumber(item);
    return Boolean(protocol && protocol !== target);
  });

  const sliceEnd = nextProtocolIndex >= 0 ? nextProtocolIndex : items.length;
  const segment = items.slice(firstTaggedIndex, sliceEnd);
  return segment.filter((item) => {
    const protocol = resolveMessageProtocolNumber(item);
    return !protocol || protocol === target;
  });
};

const resolveProtocolClosedAt = (segment: any[]): Date | null => {
  for (let i = segment.length - 1; i >= 0; i -= 1) {
    const item = segment[i];
    const text = String(item?.message || '').toLowerCase();
    if (text.includes('atendimento encerrado')) {
      return item?.createdAt || null;
    }
  }
  return null;
};

async function getCurrentUserScope(request: any) {
  const userId = String((request.user as any)?.id || '').trim();
  if (!userId) return null;

  const currentUser = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      sector: {
        include: {
          branch: true,
        },
      },
    },
  });

  const companyId = currentUser?.sector?.branch?.companyId || null;
  if (!currentUser || !companyId) return null;

  const branches = await prisma.branch.findMany({
    where: { companyId },
    select: {
      id: true,
      tradeName: true,
    },
  });

  return {
    currentUser,
    companyId,
    branchIds: branches.map((branch: { id: string }) => branch.id),
    branches,
  };
}

async function getCurrentOperatorConfig(userId: string) {
  return prisma.whatsAppConversationOperatorConfig.findUnique({
    where: { userId },
  });
}

async function requireActiveOperator(request: any, reply: any) {
  const scope = await getCurrentUserScope(request);
  if (!scope) {
    reply.code(403).send({ error: 'User not associated with a company' });
    return null;
  }

  const operatorConfig = await getCurrentOperatorConfig(scope.currentUser.id);
  if (!operatorConfig?.isActive) {
    reply.code(403).send({ error: 'Operator not enabled for WhatsApp conversations' });
    return null;
  }

  return { scope, operatorConfig };
}

async function getConversationSettings(branchId: string) {
  const existing = await prisma.whatsAppConversationSettings.findUnique({
    where: { branchId },
  });

  if (existing) return existing;

  return prisma.whatsAppConversationSettings.create({
    data: {
      branchId,
      idleTimeoutMinutes: 25,
      closeWarningMinutes: 5,
    },
  });
}

async function getBranchMessagingConfig(branchId: string) {
  const whatsappConfig = await prisma.whatsAppConfig.findUnique({ where: { branchId } });
  if (whatsappConfig?.isActive) {
    return {
      accountSid: whatsappConfig.accountSid,
      authToken: whatsappConfig.authToken,
      fromNumber: whatsappConfig.fromNumber,
      appId: whatsappConfig.appId || null,
    };
  }

  return null;
}

export default async function whatsappConversationRoutes(app: FastifyInstance) {
  app.get('/whatsapp/conversations/flows', {
    preHandler: async (request) => { await request.jwtVerify(); },
  }, async () => ({
    items: HUMAN_FLOWS,
  }));

  app.get('/whatsapp/conversations/operators', {
    preHandler: async (request) => { await request.jwtVerify(); },
  }, async (request, reply) => {
    const scope = await getCurrentUserScope(request);
    if (!scope) return reply.code(403).send({ error: 'User not associated with a company' });

    const users = await prisma.user.findMany({
      where: {
        sector: {
          branch: {
            companyId: scope.companyId,
          },
        },
      },
      include: {
        sector: {
          include: {
            branch: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    const configs = await prisma.whatsAppConversationOperatorConfig.findMany({
      where: {
        userId: { in: users.map((user: any) => user.id) },
      },
    });

    const activeCounts = await prisma.whatsAppConversation.groupBy({
      by: ['humanAssignedUserId'],
      where: {
        branchId: { in: scope.branchIds },
        humanStatus: 'ASSIGNED',
        humanAssignedUserId: { in: users.map((user: any) => user.id) },
      },
      _count: { _all: true },
    });

    const configByUserId = new Map(configs.map((config: any) => [config.userId, config]));
    const activeCountByUserId = new Map(activeCounts.map((item: any) => [String(item.humanAssignedUserId), item._count._all]));
    const settings = await getConversationSettings(scope.currentUser.sector?.branch?.id || scope.branchIds[0]);

    return {
      settings,
      items: users.map((user: any) => {
        const config = configByUserId.get(user.id) as any;
        return {
          userId: user.id,
          userName: user.name,
          userEmail: user.email,
          branchName: user.sector?.branch?.tradeName || null,
          isActive: config?.isActive ?? false,
          maxActiveConversations: config?.maxActiveConversations ?? 3,
          flowKeys: config?.flowKeys ?? [],
          activeConversationCount: activeCountByUserId.get(user.id) || 0,
        };
      }),
    };
  });

  app.get('/whatsapp/conversations/templates', {
    preHandler: async (request) => { await request.jwtVerify(); },
  }, async (request, reply) => {
    const access = await requireActiveOperator(request, reply);
    if (!access) return;

    const items = await prisma.$queryRaw<WhatsAppConversationTemplateRow[]>`
      SELECT "id", "companyId", "createdByUserId", "createdByName", "name", "text", "createdAt", "updatedAt"
      FROM "whatsapp_conversation_templates"
      WHERE "companyId" = ${access.scope.companyId}
      ORDER BY lower("name") ASC, "createdAt" DESC
    `;

    const shortcuts = await prisma.$queryRaw<{ templateId: string; shortcut: string }[]>`
      SELECT "templateId", "shortcut"
      FROM "whatsapp_template_shortcuts"
      WHERE "userId" = ${access.scope.currentUser.id}
    `;
    const shortcutMap = Object.fromEntries(shortcuts.map((s: { templateId: string; shortcut: string }) => [s.templateId, s.shortcut]));

    return { items: items.map((t: WhatsAppConversationTemplateRow) => ({ ...t, shortcut: shortcutMap[t.id] ?? null })) };
  });

  app.post('/whatsapp/conversations/templates', {
    preHandler: async (request) => { await request.jwtVerify(); },
  }, async (request, reply) => {
    const access = await requireActiveOperator(request, reply);
    if (!access) return;

    const body = request.body as { name?: string; text?: string };
    const name = normalizeOptionalString(body?.name);
    const text = typeof body?.text === 'string' ? body.text : '';

    if (!name) return reply.code(400).send({ error: 'Template name is required' });
    if (!text.trim()) return reply.code(400).send({ error: 'Template text is required' });

    const id = randomUUID();
    const now = new Date();

    await prisma.$executeRaw`
      INSERT INTO "whatsapp_conversation_templates" (
        "id", "companyId", "createdByUserId", "createdByName", "name", "text", "createdAt", "updatedAt"
      ) VALUES (
        ${id}, ${access.scope.companyId}, ${access.scope.currentUser.id},
        ${access.scope.currentUser.name}, ${name}, ${text}, ${now}, ${now}
      )
    `;

    const created = await prisma.$queryRaw<WhatsAppConversationTemplateRow[]>`
      SELECT "id", "companyId", "createdByUserId", "createdByName", "name", "text", "createdAt", "updatedAt"
      FROM "whatsapp_conversation_templates"
      WHERE "id" = ${id}
      LIMIT 1
    `;

    return reply.code(201).send({ ...created[0], shortcut: null });
  });

  app.put('/whatsapp/conversations/templates/:id', {
    preHandler: async (request) => { await request.jwtVerify(); },
  }, async (request, reply) => {
    const access = await requireActiveOperator(request, reply);
    if (!access) return;

    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; text?: string };
    const name = normalizeOptionalString(body?.name);
    const text = typeof body?.text === 'string' ? body.text : undefined;

    const existing = await prisma.$queryRaw<WhatsAppConversationTemplateRow[]>`
      SELECT "id" FROM "whatsapp_conversation_templates"
      WHERE "id" = ${id} AND "companyId" = ${access.scope.companyId}
      LIMIT 1
    `;
    if (!existing[0]) return reply.code(404).send({ error: 'Template not found' });

    if (name !== undefined && !name) return reply.code(400).send({ error: 'Template name cannot be empty' });
    if (text !== undefined && !text.trim()) return reply.code(400).send({ error: 'Template text cannot be empty' });

    const now = new Date();
    if (name !== undefined) {
      await prisma.$executeRaw`UPDATE "whatsapp_conversation_templates" SET "name" = ${name}, "updatedAt" = ${now} WHERE "id" = ${id}`;
    }
    if (text !== undefined) {
      await prisma.$executeRaw`UPDATE "whatsapp_conversation_templates" SET "text" = ${text}, "updatedAt" = ${now} WHERE "id" = ${id}`;
    }

    const updated = await prisma.$queryRaw<WhatsAppConversationTemplateRow[]>`
      SELECT "id", "companyId", "createdByUserId", "createdByName", "name", "text", "createdAt", "updatedAt"
      FROM "whatsapp_conversation_templates"
      WHERE "id" = ${id}
      LIMIT 1
    `;

    const shortcutRow = await prisma.$queryRaw<{ shortcut: string }[]>`
      SELECT "shortcut" FROM "whatsapp_template_shortcuts"
      WHERE "userId" = ${access.scope.currentUser.id} AND "templateId" = ${id}
      LIMIT 1
    `;
    return { ...updated[0], shortcut: shortcutRow[0]?.shortcut ?? null };
  });

  app.delete('/whatsapp/conversations/templates/:id', {
    preHandler: async (request) => { await request.jwtVerify(); },
  }, async (request, reply) => {
    const access = await requireActiveOperator(request, reply);
    if (!access) return;

    const { id } = request.params as { id: string };

    const existing = await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "whatsapp_conversation_templates"
      WHERE "id" = ${id} AND "companyId" = ${access.scope.companyId}
      LIMIT 1
    `;
    if (!existing[0]) return reply.code(404).send({ error: 'Template not found' });

    await prisma.$executeRaw`DELETE FROM "whatsapp_conversation_templates" WHERE "id" = ${id}`;

    return reply.code(204).send();
  });

  // Per-user shortcut for a template
  app.put('/whatsapp/conversations/templates/:id/shortcut', {
    preHandler: async (request) => { await request.jwtVerify(); },
  }, async (request, reply) => {
    const access = await requireActiveOperator(request, reply);
    if (!access) return;

    const { id } = request.params as { id: string };
    const body = request.body as { shortcut?: string | null };
    const shortcut = normalizeOptionalString(body?.shortcut) ?? null;

    const existing = await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "whatsapp_conversation_templates"
      WHERE "id" = ${id} AND "companyId" = ${access.scope.companyId}
      LIMIT 1
    `;
    if (!existing[0]) return reply.code(404).send({ error: 'Template not found' });

    const userId = access.scope.currentUser.id;

    if (!shortcut) {
      await prisma.$executeRaw`
        DELETE FROM "whatsapp_template_shortcuts" WHERE "userId" = ${userId} AND "templateId" = ${id}
      `;
      return { shortcut: null };
    }

    await prisma.$executeRaw`
      INSERT INTO "whatsapp_template_shortcuts" ("id", "userId", "templateId", "shortcut", "createdAt", "updatedAt")
      VALUES (${randomUUID()}, ${userId}, ${id}, ${shortcut}, NOW(), NOW())
      ON CONFLICT ("userId", "templateId") DO UPDATE SET "shortcut" = ${shortcut}, "updatedAt" = NOW()
    `;

    return { shortcut };
  });

  app.put('/whatsapp/conversations/settings', {
    preHandler: async (request) => { await request.jwtVerify(); },
  }, async (request, reply) => {
    const scope = await getCurrentUserScope(request);
    if (!scope) return reply.code(403).send({ error: 'User not associated with a company' });

    const body = request.body as {
      idleTimeoutMinutes?: number;
      closeWarningMinutes?: number;
    };

    const branchId = scope.currentUser.sector?.branch?.id || scope.branchIds[0];
    if (!branchId) {
      return reply.code(403).send({ error: 'User not associated with a branch' });
    }

    const idleTimeoutMinutes = Math.max(1, Number(body?.idleTimeoutMinutes || 25));
    const closeWarningMinutes = Math.max(1, Number(body?.closeWarningMinutes || 5));

    const settings = await prisma.whatsAppConversationSettings.upsert({
      where: { branchId },
      create: {
        branchId,
        idleTimeoutMinutes,
        closeWarningMinutes,
      },
      update: {
        idleTimeoutMinutes,
        closeWarningMinutes,
      },
    });

    return settings;
  });

  app.put('/whatsapp/conversations/operators/:userId', {
    preHandler: async (request) => { await request.jwtVerify(); },
  }, async (request, reply) => {
    const scope = await getCurrentUserScope(request);
    if (!scope) return reply.code(403).send({ error: 'User not associated with a company' });

    const { userId } = request.params as { userId: string };
    const body = request.body as {
      isActive?: boolean;
      maxActiveConversations?: number;
      flowKeys?: string[];
    };

    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        sector: {
          include: {
            branch: true,
          },
        },
      },
    });

    if (!targetUser || targetUser.sector?.branch?.companyId !== scope.companyId) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const flowKeys = Array.isArray(body?.flowKeys)
      ? Array.from(new Set(body.flowKeys.map((item) => String(item || '').trim()).filter(Boolean)))
      : [];

    const maxActiveConversations = Math.max(1, Number(body?.maxActiveConversations || 3));

    const config = await prisma.whatsAppConversationOperatorConfig.upsert({
      where: { userId },
      create: {
        userId,
        isActive: body?.isActive !== false,
        maxActiveConversations,
        flowKeys,
      },
      update: {
        isActive: body?.isActive !== false,
        maxActiveConversations,
        flowKeys,
      },
    });

    return config;
  });

  app.get('/whatsapp/conversations', {
    preHandler: async (request) => { await request.jwtVerify(); },
  }, async (request, reply) => {
    const scope = await getCurrentUserScope(request);
    if (!scope) return reply.code(403).send({ error: 'User not associated with a company' });

    const query = request.query as {
      status?: string;
      search?: string;
      flowKey?: string;
      mineOnly?: string;
    };

    const operatorConfig = await getCurrentOperatorConfig(scope.currentUser.id);
    if (operatorConfig && !operatorConfig.isActive) {
      return { items: [] };
    }

    const status = normalizeHumanStatus(query?.status);
    const search = normalizeOptionalString(query?.search);
    const flowKey = normalizeOptionalString(query?.flowKey);
    const mineOnly = String(query?.mineOnly || '').trim().toLowerCase() === 'true';

    const where: Prisma.WhatsAppConversationWhereInput = {
      branchId: { in: scope.branchIds },
      humanStatus: status === 'ALL' ? { not: null } : status,
    };

    if (search) {
      where.OR = [
        { patientName: { contains: search, mode: 'insensitive' } },
        { phone: { contains: normalizePhone(search) || search } },
        { humanFlowLabel: { contains: search, mode: 'insensitive' } },
        { humanProtocolNumber: { contains: search, mode: 'insensitive' } },
        { lastInboundMessage: { contains: search, mode: 'insensitive' } },
        { lastOutboundMessage: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (flowKey) {
      where.humanFlowKey = flowKey;
    } else if (operatorConfig?.flowKeys?.length) {
      where.humanFlowKey = { in: operatorConfig.flowKeys };
    }

    if (mineOnly) {
      where.humanAssignedUserId = scope.currentUser.id;
    }

    const items = await prisma.whatsAppConversation.findMany({
      where,
      orderBy: [
        { updatedAt: 'desc' },
      ],
      take: 200,
    });

    return {
      items: items.map((item: any) => ({
        ...item,
        canView: !operatorConfig?.flowKeys?.length || operatorConfig.flowKeys.includes(String(item.humanFlowKey || '')),
      })),
    };
  });

  app.get('/whatsapp/conversations/:id/messages', {
    preHandler: async (request) => { await request.jwtVerify(); },
  }, async (request, reply) => {
    const scope = await getCurrentUserScope(request);
    if (!scope) return reply.code(403).send({ error: 'User not associated with a company' });

    const { id } = request.params as { id: string };
    const query = request.query as { protocolNumber?: string; includeAll?: string };
    const conversation = await prisma.whatsAppConversation.findFirst({
      where: {
        id,
        branchId: { in: scope.branchIds },
      },
    });

    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });

    const operatorConfig = await getCurrentOperatorConfig(scope.currentUser.id);
    if (operatorConfig?.flowKeys?.length && conversation.humanFlowKey && !operatorConfig.flowKeys.includes(conversation.humanFlowKey)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const items = await prisma.whatsAppConversationMessage.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
    });
    const shouldIncludeAll = String(query?.includeAll || '').trim().toLowerCase() === 'true';
    const targetProtocol = normalizeProtocolNumber(query?.protocolNumber)
      || (!shouldIncludeAll ? normalizeProtocolNumber(conversation.humanProtocolNumber) : null);
    const scopedItems = targetProtocol ? sliceMessagesByProtocol(items, targetProtocol) : items;

    const patientDetails = conversation.patientId
      ? await prisma.patient.findFirst({
        where: {
          id: conversation.patientId,
          branchId: { in: scope.branchIds },
        },
        select: {
          id: true,
          name: true,
          cpf: true,
          cellphone: true,
          phone: true,
          birthDate: true,
          healthInsuranceName: true,
          healthInsuranceNumber: true,
          email: true,
          address: true,
          observations: true,
        },
      })
      : null;

    const patientAppointments = conversation.patientId
      ? await prisma.appointment.findMany({
        where: {
          patientId: conversation.patientId,
          branchId: { in: scope.branchIds },
          isActive: true,
        },
        select: {
          id: true,
          date: true,
          time: true,
          type: true,
          status: true,
          doctorName: true,
          specialty: true,
          convenio: true,
        },
      })
      : [];

    const nowComparable = buildComparableSlot(
      new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }),
      new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false })
    );

    const sortedAppointments = [...patientAppointments].sort((a: any, b: any) => (
      buildComparableSlot(a.date, a.time).localeCompare(buildComparableSlot(b.date, b.time))
    ));

    const nextAppointment = sortedAppointments.find((item: any) => buildComparableSlot(item.date, item.time) >= nowComparable) || null;
    const recentAppointments = [...sortedAppointments]
      .filter((item: any) => buildComparableSlot(item.date, item.time) < nowComparable)
      .reverse()
      .slice(0, 3);

    const mediaItems = await prisma.whatsAppConversationMedia.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
    });

    return {
      conversation,
      patient: patientDetails,
      appointments: {
        next: nextAppointment,
        recent: recentAppointments,
      },
      items: scopedItems,
      media: mediaItems,
    };
  });

  app.get('/whatsapp/conversations/:id/protocols/:protocolNumber', {
    preHandler: async (request) => { await request.jwtVerify(); },
  }, async (request, reply) => {
    const scope = await getCurrentUserScope(request);
    if (!scope) return reply.code(403).send({ error: 'User not associated with a company' });

    const { id, protocolNumber } = request.params as { id: string; protocolNumber: string };
    const normalizedProtocol = normalizeProtocolNumber(protocolNumber);
    if (!normalizedProtocol) return reply.code(400).send({ error: 'Protocol number is required' });

    const conversation = await prisma.whatsAppConversation.findFirst({
      where: {
        id,
        branchId: { in: scope.branchIds },
      },
    });

    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });

    const operatorConfig = await getCurrentOperatorConfig(scope.currentUser.id);
    if (operatorConfig?.flowKeys?.length && conversation.humanFlowKey && !operatorConfig.flowKeys.includes(conversation.humanFlowKey)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const items = await prisma.whatsAppConversationMessage.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
    });
    const scopedItems = sliceMessagesByProtocol(items, normalizedProtocol);

    return {
      conversation,
      protocol: {
        number: normalizedProtocol,
        startedAt: scopedItems[0]?.createdAt || null,
        closedAt: resolveProtocolClosedAt(scopedItems)
          || (conversation.humanProtocolNumber === normalizedProtocol ? conversation.humanProtocolClosedAt : null),
      },
      items: scopedItems,
    };
  });

  app.post('/whatsapp/conversations/:id/claim', {
    preHandler: async (request) => { await request.jwtVerify(); },
  }, async (request, reply) => {
    const scope = await getCurrentUserScope(request);
    if (!scope) return reply.code(403).send({ error: 'User not associated with a company' });

    const { id } = request.params as { id: string };
    const conversation = await prisma.whatsAppConversation.findFirst({
      where: {
        id,
        branchId: { in: scope.branchIds },
      },
    });

    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });

    const operatorConfig = await getCurrentOperatorConfig(scope.currentUser.id);
    if (!operatorConfig?.isActive) {
      return reply.code(403).send({ error: 'Operator not enabled for WhatsApp conversations' });
    }

    if (conversation.humanStatus === 'CLOSED') {
      return reply.code(400).send({ error: 'Conversa encerrada não pode ser assumida novamente' });
    }

    // Check if the conversation is already assigned to the current user
    if (conversation.humanStatus === 'ASSIGNED' && conversation.humanAssignedUserId === scope.currentUser.id) {
      return reply.code(400).send({ error: 'Você já está atendendo esta conversa' });
    }

    if (operatorConfig.flowKeys.length && conversation.humanFlowKey && !operatorConfig.flowKeys.includes(conversation.humanFlowKey)) {
      return reply.code(403).send({ error: 'Flow not allowed for this operator' });
    }

    const activeCount = await prisma.whatsAppConversation.count({
      where: {
        branchId: { in: scope.branchIds },
        humanStatus: 'ASSIGNED',
        humanAssignedUserId: scope.currentUser.id,
      },
    });

    if (activeCount >= operatorConfig.maxActiveConversations) {
      return reply.code(400).send({ error: 'Operator reached active conversation limit' });
    }

    const messagingConfig = await getBranchMessagingConfig(conversation.branchId);
    if (!messagingConfig) {
      return reply.code(400).send({ error: 'WhatsApp configuration not found for this branch' });
    }

    const gupshup = createMessagingService(messagingConfig);
    const now = new Date();
    const previousOperatorName = conversation.humanAssignedUserName || null;
    const takeover = conversation.humanStatus === 'ASSIGNED' && conversation.humanAssignedUserId && conversation.humanAssignedUserId !== scope.currentUser.id;
    const greetingMessage = takeover
      ? buildTransferMessage(scope.currentUser.name)
      : buildOperatorGreeting(scope.currentUser.name);
    const queueMessage = takeover
      ? `[Fila humana] Conversa transferida para ${scope.currentUser.name}.`
      : `[Fila humana] Conversa assumida por ${scope.currentUser.name}.`;

    const sendResult = await gupshup.sendTextMessage({
      to: conversation.phone,
      message: greetingMessage,
    });

    const updated = await prisma.whatsAppConversation.update({
      where: { id },
      data: {
        humanStatus: 'ASSIGNED',
        humanAssignedUserId: scope.currentUser.id,
        humanAssignedUserName: scope.currentUser.name,
        humanAssignedAt: now,
        humanIdleWarningSentAt: null,
        humanLastOperatorMessageAt: now,
        lastOutboundMessage: greetingMessage,
        lastInteractionAt: now,
      },
    });

    await prisma.whatsAppConversationMessage.create({
      data: {
        conversationId: conversation.id,
        branchId: conversation.branchId,
        phone: conversation.phone,
        flowKey: conversation.humanFlowKey || null,
        authorType: 'SYSTEM',
        authorUserId: scope.currentUser.id,
        authorName: scope.currentUser.name,
        metadata: conversation.humanProtocolNumber
          ? { protocolNumber: conversation.humanProtocolNumber }
          : undefined,
        message: previousOperatorName && takeover
          ? `${queueMessage}\nOperador anterior: ${previousOperatorName}.`
          : queueMessage,
      },
    });

    await prisma.whatsAppConversationMessage.create({
      data: {
        conversationId: conversation.id,
        branchId: conversation.branchId,
        phone: conversation.phone,
        flowKey: conversation.humanFlowKey || null,
        authorType: 'OPERATOR',
        authorUserId: scope.currentUser.id,
        authorName: scope.currentUser.name,
        providerMessageId: sendResult.messageId || null,
        metadata: {
          ...(sendResult.messageId ? { event: 'operator-claim-greeting' } : {}),
          ...(conversation.humanProtocolNumber ? { protocolNumber: conversation.humanProtocolNumber } : {}),
        },
        message: greetingMessage,
      },
    });

    return updated;
  });

  app.post('/whatsapp/conversations/:id/messages', {
    preHandler: async (request) => { await request.jwtVerify(); },
  }, async (request, reply) => {
    const scope = await getCurrentUserScope(request);
    if (!scope) return reply.code(403).send({ error: 'User not associated with a company' });

    const { id } = request.params as { id: string };
    const body = request.body as { message?: string };
    const message = normalizeOptionalString(body?.message);
    if (!message) return reply.code(400).send({ error: 'Message is required' });

    const conversation = await prisma.whatsAppConversation.findFirst({
      where: {
        id,
        branchId: { in: scope.branchIds },
      },
    });

    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });
    if (conversation.humanAssignedUserId !== scope.currentUser.id) {
      return reply.code(403).send({ error: 'Conversation must be assigned to you before sending messages' });
    }

    const messagingConfig = await getBranchMessagingConfig(conversation.branchId);
    if (!messagingConfig) {
      return reply.code(400).send({ error: 'WhatsApp configuration not found for this branch' });
    }

    const gupshup = createMessagingService(messagingConfig);
    const formattedMessage = buildOperatorSignature(message, scope.currentUser.name);
    const sendResult = await gupshup.sendTextMessage({
      to: conversation.phone,
      message: formattedMessage,
    });

    const now = new Date();
    await prisma.whatsAppConversation.update({
      where: { id },
      data: {
        lastOutboundMessage: formattedMessage,
        lastInteractionAt: now,
        humanLastOperatorMessageAt: now,
        humanIdleWarningSentAt: null,
      },
    });

    const created = await prisma.whatsAppConversationMessage.create({
      data: {
        conversationId: conversation.id,
        branchId: conversation.branchId,
        phone: conversation.phone,
        flowKey: conversation.humanFlowKey || null,
        authorType: 'OPERATOR',
        authorUserId: scope.currentUser.id,
        authorName: scope.currentUser.name,
        providerMessageId: sendResult.messageId || null,
        metadata: conversation.humanProtocolNumber
          ? { protocolNumber: conversation.humanProtocolNumber }
          : undefined,
        message: formattedMessage,
      },
    });

    return created;
  });

  app.post('/whatsapp/conversations/:id/close', {
    preHandler: async (request) => { await request.jwtVerify(); },
  }, async (request, reply) => {
    const scope = await getCurrentUserScope(request);
    if (!scope) return reply.code(403).send({ error: 'User not associated with a company' });

    const { id } = request.params as { id: string };
    const conversation = await prisma.whatsAppConversation.findFirst({
      where: {
        id,
        branchId: { in: scope.branchIds },
      },
    });

    if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });
    if (conversation.humanAssignedUserId && conversation.humanAssignedUserId !== scope.currentUser.id) {
      return reply.code(403).send({ error: 'Only the assigned operator can close this conversation' });
    }

    const messagingConfig = await getBranchMessagingConfig(conversation.branchId);
    if (!messagingConfig) {
      return reply.code(400).send({ error: 'WhatsApp configuration not found for this branch' });
    }

    const closingMessage = 'Seu atendimento via WhatsApp foi encerrado. Se precisar de algo mais, envie uma nova mensagem e o fluxo será iniciado novamente.';

    const gupshup = createMessagingService(messagingConfig);
    await gupshup.sendTextMessage({
      to: conversation.phone,
      message: closingMessage,
    });

    const now = new Date();
    const updated = await prisma.whatsAppConversation.update({
      where: { id },
      data: {
        state: 'MENU',
        context: {},
        selectedService: null,
        humanStatus: 'CLOSED',
        humanAssignedUserId: null,
        humanAssignedUserName: null,
        humanIdleWarningSentAt: null,
        humanClosedAt: now,
        humanClosedByUserId: scope.currentUser.id,
        humanClosedByUserName: scope.currentUser.name,
        humanProtocolClosedAt: now,
        lastOutboundMessage: closingMessage,
        lastInteractionAt: now,
      },
    });

    await prisma.whatsAppConversationMessage.create({
      data: {
        conversationId: conversation.id,
        branchId: conversation.branchId,
        phone: conversation.phone,
        flowKey: conversation.humanFlowKey || null,
        authorType: 'SYSTEM',
        authorUserId: scope.currentUser.id,
        authorName: scope.currentUser.name,
        metadata: conversation.humanProtocolNumber
          ? { protocolNumber: conversation.humanProtocolNumber, event: 'protocol-closed' }
          : { event: 'protocol-closed' },
        message: `[Protocolo ${conversation.humanProtocolNumber || '-'}] Atendimento encerrado.\n${closingMessage}`,
      },
    });

    return updated;
  });

  /**
   * GET /care/whatsapp/media/:mediaId
   * Busca a URL de uma mídia do WhatsApp usando o mediaId
   */
  app.get<{
    Params: { mediaId: string };
  }>('/whatsapp/media/:mediaId', {
    preHandler: async (request) => { await request.jwtVerify(); },
    schema: {
      summary: 'Get WhatsApp media URL',
      description: 'Fetches the media URL from Gupshup using the mediaId',
      tags: ['WhatsApp'],
      params: {
        type: 'object',
        properties: {
          mediaId: { type: 'string' },
        },
        required: ['mediaId'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            mediaId: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { mediaId } = request.params;
    const scope = await getCurrentUserScope(request);

    if (!mediaId) {
      return reply.code(400).send({ error: 'mediaId is required' });
    }

    if (!scope) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    const preferredBranchId = String(scope.currentUser?.sector?.branch?.id || '').trim();
    const branchId = preferredBranchId || String(scope.branchIds?.[0] || '').trim();
    const branchMessaging = branchId ? await getBranchMessagingConfig(branchId) : null;
    if (!branchMessaging) {
      return reply.code(503).send({ error: 'WhatsApp configuration not available' });
    }

    try {
      const gupshup = createMessagingService(branchMessaging);

      const mediaData = await gupshup.getMediaUrl(mediaId);
      
      if (!mediaData?.url) {
        return reply.code(404).send({ error: 'Media URL not found' });
      }

      return {
        url: mediaData.url,
        mediaId,
      };
    } catch (error: any) {
      request.log.error({ error, mediaId }, 'Failed to fetch media URL');
      return reply.code(500).send({ error: 'Failed to fetch media URL' });
    }
  });
}
