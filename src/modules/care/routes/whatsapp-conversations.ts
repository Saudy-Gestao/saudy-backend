import { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import GupshupService from '../lib/gupshup';
import { HUMAN_FLOWS } from '../lib/whatsapp-chatbot';

const normalizeOptionalString = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const normalizePhone = (value: unknown) => String(value || '').replace(/\D/g, '');

const HUMAN_STATUSES = ['QUEUED', 'ASSIGNED', 'CLOSED'] as const;

type HumanStatus = (typeof HUMAN_STATUSES)[number];

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

async function getBranchMessagingConfig(branchId: string) {
  const whatsappConfig = await prisma.whatsAppConfig.findUnique({ where: { branchId } });
  if (whatsappConfig?.isActive) {
    return {
      apiKey: whatsappConfig.accountSid,
      appName: whatsappConfig.authToken,
      sourceNumber: whatsappConfig.fromNumber,
    };
  }

  if (process.env.GUPSHUP_API_KEY && process.env.GUPSHUP_APP_NAME && process.env.GUPSHUP_SOURCE_NUMBER) {
    return {
      apiKey: String(process.env.GUPSHUP_API_KEY),
      appName: String(process.env.GUPSHUP_APP_NAME),
      sourceNumber: String(process.env.GUPSHUP_SOURCE_NUMBER),
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

    return {
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

    return {
      conversation,
      items,
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

    const updated = await prisma.whatsAppConversation.update({
      where: { id },
      data: {
        humanStatus: 'ASSIGNED',
        humanAssignedUserId: scope.currentUser.id,
        humanAssignedUserName: scope.currentUser.name,
        humanAssignedAt: new Date(),
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

    const gupshup = new GupshupService(messagingConfig);
    const formattedMessage = buildOperatorSignature(message, scope.currentUser.name);
    await gupshup.sendTextMessage({
      to: conversation.phone,
      message: formattedMessage,
    });

    await prisma.whatsAppConversation.update({
      where: { id },
      data: {
        lastOutboundMessage: formattedMessage,
        lastInteractionAt: new Date(),
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
    const body = request.body as { message?: string };
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

    const closingMessage = normalizeOptionalString(body?.message)
      || 'Seu atendimento via WhatsApp foi encerrado. Se precisar de algo mais, envie uma nova mensagem e o fluxo será iniciado novamente.';

    const gupshup = new GupshupService(messagingConfig);
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
        humanClosedAt: now,
        humanClosedByUserId: scope.currentUser.id,
        humanClosedByUserName: scope.currentUser.name,
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
        message: closingMessage,
      },
    });

    return updated;
  });
}
