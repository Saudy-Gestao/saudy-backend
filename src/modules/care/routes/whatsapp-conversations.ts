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

const buildOperatorGreeting = (operatorName: string) => {
  const hour = new Date().getHours();
  const period = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  return `${period}. Como posso ajudar?\n\nAtendimento: ${operatorName}`;
};

const buildTransferMessage = (operatorName: string) => (
  `Estamos realizando uma alteração no seu atendimento. A partir de agora, ${operatorName} seguirá com você.\n\nAtendimento: ${operatorName}`
);

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
          idleTimeoutMinutes: config?.idleTimeoutMinutes ?? 25,
          closeWarningMinutes: config?.closeWarningMinutes ?? 5,
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
      idleTimeoutMinutes?: number;
      closeWarningMinutes?: number;
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
    const idleTimeoutMinutes = Math.max(1, Number(body?.idleTimeoutMinutes || 25));
    const closeWarningMinutes = Math.max(1, Number(body?.closeWarningMinutes || 5));

    const config = await prisma.whatsAppConversationOperatorConfig.upsert({
      where: { userId },
      create: {
        userId,
        isActive: body?.isActive !== false,
        maxActiveConversations,
        idleTimeoutMinutes,
        closeWarningMinutes,
        flowKeys,
      },
      update: {
        isActive: body?.isActive !== false,
        maxActiveConversations,
        idleTimeoutMinutes,
        closeWarningMinutes,
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

    return {
      conversation,
      patient: patientDetails,
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

    if (conversation.humanStatus === 'CLOSED') {
      return reply.code(400).send({ error: 'Conversa encerrada não pode ser assumida novamente' });
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

    const gupshup = new GupshupService(messagingConfig);
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
        metadata: sendResult.messageId ? { event: 'operator-claim-greeting' } : undefined,
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

    const gupshup = new GupshupService(messagingConfig);
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
        message: `[Protocolo ${conversation.humanProtocolNumber || '-'}] Atendimento encerrado.\n${closingMessage}`,
      },
    });

    return updated;
  });
}
