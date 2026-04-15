import { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import prisma from '../lib/prisma';
import WhatsAppAutoSender from '../lib/whatsapp-auto-sender';
import handleWhatsAppChatbot from '../lib/whatsapp-chatbot';
import GupshupService from '../lib/gupshup';

const normalizeValue = (value: unknown) => String(value || '').trim().toLowerCase();

const collectStringCandidates = (value: unknown, candidates = new Set<string>()): Set<string> => {
  if (value == null) return candidates;

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const normalized = normalizeValue(value);
    if (normalized) candidates.add(normalized);
    return candidates;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectStringCandidates(item, candidates);
    return candidates;
  }

  if (typeof value === 'object') {
    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      collectStringCandidates(nestedValue, candidates);
    }
  }

  return candidates;
};

const parseConfirmationAction = (payload: any): 'CONFIRMED' | 'RESCHEDULE' | null => {
  const candidates = Array.from(collectStringCandidates(payload));

  for (const value of candidates) {
    if (value === '1' || value.includes('confirm')) return 'CONFIRMED';
    if (value === '2' || value.includes('reagend') || value.includes('resched')) return 'RESCHEDULE';
  }

  return null;
};

const CONFIRMATION_TERMINAL_STATUSES = new Set([
  'RESPONDED_CONFIRMED',
  'RESPONDED_RESCHEDULE',
]);

const RESCHEDULE_CONFIRMATION_FLOW = {
  key: 'CONFIRMACAO_REAGENDAMENTO',
  label: 'Reagendamento de confirmação',
} as const;

const normalizePhoneForConversation = (value: unknown) => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length > 11 ? digits.slice(-11) : digits;
};

const normalizePhoneForConfig = (value: unknown) => {
  return String(value || '').replace(/\D/g, '');
};

const collectPhoneCandidates = (value: unknown, candidates = new Set<string>()): Set<string> => {
  if (value == null) return candidates;

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const digits = normalizePhoneForConfig(value);
    if (digits.length >= 10 && digits.length <= 15) {
      candidates.add(digits);
      if (digits.length > 11) candidates.add(digits.slice(-11));
    }
    return candidates;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectPhoneCandidates(item, candidates);
    return candidates;
  }

  if (typeof value === 'object') {
    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      collectPhoneCandidates(nestedValue, candidates);
    }
  }

  return candidates;
};

const uniqueBranchIds = (branchIds: Array<string | null | undefined>) => {
  return Array.from(new Set(branchIds.map((value) => String(value || '').trim()).filter(Boolean)));
};

const findMatchingBranchIdsByConfigNumber = (
  configs: Array<{ branchId: string; fromNumber: string }>,
  candidateNumbers: string[],
) => {
  return uniqueBranchIds(configs.filter((config) => {
    const fromDigits = normalizePhoneForConfig(config.fromNumber);
    if (!fromDigits) return false;

    return candidateNumbers.some((candidate) => (
      fromDigits === candidate
      || fromDigits.endsWith(candidate)
      || candidate.endsWith(fromDigits)
    ));
  }).map((config) => config.branchId));
};

async function resolveBranchHintFromSourcePhone(
  sourcePhone: string,
  activeBranchIds: string[],
): Promise<string | null> {
  const phone = normalizePhoneForConversation(sourcePhone);
  if (!phone || !activeBranchIds.length) return null;

  const existingConversations = await prisma.whatsAppConversation.findMany({
    where: {
      branchId: { in: activeBranchIds },
      phone,
    },
    select: {
      branchId: true,
      lastInteractionAt: true,
    },
    orderBy: { lastInteractionAt: 'desc' },
    take: 5,
  });

  const conversationBranchIds = uniqueBranchIds(existingConversations.map((item: { branchId: string }) => item.branchId));
  if (conversationBranchIds.length === 1) return conversationBranchIds[0];

  const recentLogs = await prisma.whatsAppMessageLog.findMany({
    where: {
      branchId: { in: activeBranchIds },
      patientPhone: { contains: phone },
    },
    select: {
      branchId: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  const logBranchIds = uniqueBranchIds(recentLogs.map((item: { branchId: string }) => item.branchId));
  if (logBranchIds.length === 1) return logBranchIds[0];

  const matchingPatients = await prisma.patient.findMany({
    where: {
      branchId: { in: activeBranchIds },
      isActive: true,
      OR: [
        { cellphone: { contains: phone } },
        { phone: { contains: phone } },
      ],
    },
    select: {
      branchId: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: 'desc' },
    take: 10,
  });

  const patientBranchIds = uniqueBranchIds(matchingPatients.map((item: { branchId: string | null }) => item.branchId));
  if (patientBranchIds.length === 1) return patientBranchIds[0];

  return null;
}

async function resolveBranchHintFromPayload(payload: unknown, sourcePhone?: string): Promise<string | null> {
  const configs = await prisma.whatsAppConfig.findMany({
    where: { isActive: true },
    select: {
      branchId: true,
      fromNumber: true,
    },
  });

  const activeBranchIds = uniqueBranchIds(configs.map((config: { branchId: string }) => config.branchId));
  const sourceDigits = normalizePhoneForConfig(sourcePhone || '');
  const candidateNumbers = Array.from(collectPhoneCandidates(payload)).filter((candidate) => {
    if (!candidate) return false;
    if (!sourceDigits) return true;
    return candidate !== sourceDigits && candidate.slice(-11) !== sourceDigits.slice(-11);
  });

  if (candidateNumbers.length) {
    const matchingBranchIds = findMatchingBranchIdsByConfigNumber(configs, candidateNumbers);
    if (matchingBranchIds.length === 1) return matchingBranchIds[0];
  }

  if (sourcePhone) {
    return resolveBranchHintFromSourcePhone(sourcePhone, activeBranchIds);
  }

  return null;
}

const makeProtocolNumber = () => {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const suffix = randomBytes(3).toString('hex').toUpperCase();
  return `WA-${y}${m}${d}-${suffix}`;
};

const pickFirstString = (value: unknown, keys: string[]): string => {
  if (!value || typeof value !== 'object') return '';
  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = String(obj[key] || '').trim();
    if (candidate) return candidate;
  }
  return '';
};

const findMediaCandidate = (value: unknown): Record<string, unknown> | null => {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMediaCandidate(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;

  const obj = value as Record<string, unknown>;
  const type = pickFirstString(obj, ['type', 'mediaType', 'mimeType', 'mimetype']).toLowerCase();
  const url = pickFirstString(obj, ['url', 'link', 'href', 'downloadUrl', 'mediaUrl', 'imageUrl', 'videoUrl', 'audioUrl']);
  const mediaId = pickFirstString(obj, ['id', 'mediaId', 'messageId']);

  const looksLikeMedia = Boolean(
    url
    || mediaId
    || type.includes('image')
    || type.includes('video')
    || type.includes('audio')
    || type.includes('document')
    || type.includes('application')
    || type.includes('file'),
  );

  if (looksLikeMedia) return obj;

  for (const nestedValue of Object.values(obj)) {
    const found = findMediaCandidate(nestedValue);
    if (found) return found;
  }
  return null;
};

const extractInboundMedia = (payload: any): {
  summary: string;
  metadata?: Record<string, unknown>;
} => {
  // Try to find media in the standard Gupshup structure first: payload.payload for inbound media
  let source = null;

  // Gupshup inbound media comes in payload.payload structure
  if (payload?.payload?.url) {
    source = payload.payload;
  } else {
    // Fallback to recursive search
    source = findMediaCandidate(payload) || findMediaCandidate(payload?.payload) || findMediaCandidate(payload?.message);
  }

  if (!source) {
    return { summary: '' };
  }

  const rawType = pickFirstString(source, ['type', 'mediaType', 'mimeType', 'mimetype', 'contentType']).toLowerCase();
  const mimeType = pickFirstString(source, ['mimeType', 'mimetype', 'contentType']) || rawType;
  const mediaUrl = pickFirstString(source, ['url', 'link', 'href', 'downloadUrl', 'mediaUrl', 'imageUrl', 'videoUrl', 'audioUrl']);
  const fileName = pickFirstString(source, ['caption', 'filename', 'fileName', 'name', 'title']);
  const mediaId = pickFirstString(source, ['mediaId', 'id']);
  const urlExpiry = source.urlExpiry || null;

  const inferredType = rawType.includes('image') || mimeType.includes('image')
    ? 'image'
    : rawType.includes('video') || mimeType.includes('video')
      ? 'video'
      : rawType.includes('audio') || mimeType.includes('audio')
        ? 'audio'
        : 'document';

  const label = inferredType === 'image'
    ? 'Imagem'
    : inferredType === 'video'
      ? 'Vídeo'
      : inferredType === 'audio'
        ? 'Áudio'
        : 'Documento';

  const summary = `[${label} recebido]${fileName ? ` ${fileName}` : ''}${mediaUrl ? ` (${mediaUrl})` : ''}`;
  const metadata: Record<string, unknown> = {
    mediaType: inferredType,
    mimeType: mimeType || null,
    mediaUrl: mediaUrl || null,
    fileName: fileName || null,
    mediaId: mediaId || null,
    urlExpiry: urlExpiry,
  };

  return { summary, metadata };
};

const appendObservation = (existing: string | null | undefined, note: string) => {
  const trimmedExisting = String(existing || '').trim();
  return trimmedExisting ? `${trimmedExisting}\n${note}` : note;
};

async function sendDecisionLockedGuidance(params: {
  branchId: string;
  phone?: string | null;
  message: string;
}) {
  const normalizedPhone = normalizePhoneForConversation(params.phone || '');
  if (!normalizedPhone) return;

  const whatsappConfig = await prisma.whatsAppConfig.findUnique({
    where: { branchId: params.branchId },
    select: {
      accountSid: true,
      authToken: true,
      fromNumber: true,
      isActive: true,
    },
  });

  const apiKey = whatsappConfig?.accountSid;
  const appName = whatsappConfig?.authToken;
  const sourceNumber = whatsappConfig?.fromNumber;
  const canUseBranchConfig = Boolean(whatsappConfig?.isActive && apiKey && appName && sourceNumber);

  if (!canUseBranchConfig) return;

  const gupshup = new GupshupService({
    apiKey,
    appName,
    sourceNumber,
  });

  try {
    await gupshup.sendTextMessage({
      to: normalizedPhone,
      message: params.message,
    });
  } catch {
    console.log('Failed to send guidance message via Gupshup');
  }
}

async function queueRescheduleHumanConversation(tx: Prisma.TransactionClient, params: {
  branchId: string;
  phone: string;
  appointmentId: string;
  patientId?: string | null;
  patientName?: string | null;
}) {
  const phone = normalizePhoneForConversation(params.phone);
  if (!phone) return null;

  const now = new Date();
  const existing = await tx.whatsAppConversation.findUnique({
    where: {
      branchId_phone: {
        branchId: params.branchId,
        phone,
      },
    },
    select: {
      id: true,
      humanStatus: true,
      humanFlowKey: true,
      humanProtocolNumber: true,
      patientId: true,
      patientName: true,
    },
  });

  const hasActiveProtocol = Boolean(
    existing
    && existing.humanStatus
    && existing.humanStatus !== 'CLOSED'
    && existing.humanProtocolNumber,
  );

  const protocolNumber = hasActiveProtocol
    ? String(existing?.humanProtocolNumber)
    : makeProtocolNumber();

  const conversation = await tx.whatsAppConversation.upsert({
    where: {
      branchId_phone: {
        branchId: params.branchId,
        phone,
      },
    },
    create: {
      branchId: params.branchId,
      phone,
      patientId: params.patientId || null,
      patientName: params.patientName || null,
      state: 'HANDED_OFF',
      selectedService: 'REAGENDAMENTO',
      context: {},
      lastInboundMessage: 'Reagendar',
      lastOutboundMessage: 'Em breve um atendente entrará em contato para realizar seu reagendamento.',
      humanStatus: 'QUEUED',
      humanFlowKey: RESCHEDULE_CONFIRMATION_FLOW.key,
      humanFlowLabel: RESCHEDULE_CONFIRMATION_FLOW.label,
      humanAssignedUserId: null,
      humanAssignedUserName: null,
      humanAssignedAt: null,
      humanClosedAt: null,
      humanClosedByUserId: null,
      humanClosedByUserName: null,
      humanProtocolNumber: protocolNumber,
      humanProtocolStartedAt: now,
      humanProtocolClosedAt: null,
      humanIdleWarningSentAt: null,
      humanLastOperatorMessageAt: null,
      humanLastPatientMessageAt: now,
      lastInteractionAt: now,
    },
    update: {
      patientId: params.patientId || existing?.patientId || null,
      patientName: params.patientName || existing?.patientName || null,
      lastInboundMessage: 'Reagendar',
      lastOutboundMessage: 'Em breve um atendente entrará em contato para realizar seu reagendamento.',
      humanLastPatientMessageAt: now,
      lastInteractionAt: now,
      ...(hasActiveProtocol ? {} : {
        state: 'HANDED_OFF',
        selectedService: 'REAGENDAMENTO',
        humanStatus: 'QUEUED',
        humanFlowKey: RESCHEDULE_CONFIRMATION_FLOW.key,
        humanFlowLabel: RESCHEDULE_CONFIRMATION_FLOW.label,
        humanAssignedUserId: null,
        humanAssignedUserName: null,
        humanAssignedAt: null,
        humanClosedAt: null,
        humanClosedByUserId: null,
        humanClosedByUserName: null,
        humanProtocolNumber: protocolNumber,
        humanProtocolStartedAt: now,
        humanProtocolClosedAt: null,
        humanIdleWarningSentAt: null,
        humanLastOperatorMessageAt: null,
      }),
    },
  });

  const flowKey = hasActiveProtocol
    ? (conversation.humanFlowKey || RESCHEDULE_CONFIRMATION_FLOW.key)
    : RESCHEDULE_CONFIRMATION_FLOW.key;

  const systemMessage = hasActiveProtocol
    ? `[Protocolo ${protocolNumber}] Paciente solicitou reagendamento via confirmação automática.`
    : `[Protocolo ${protocolNumber}] Conversa encaminhada para atendimento humano.\n[Fila humana] ${RESCHEDULE_CONFIRMATION_FLOW.label}\nPaciente solicitou reagendamento pela confirmação automática de consulta.`;

  await tx.whatsAppConversationMessage.create({
    data: {
      conversationId: conversation.id,
      branchId: params.branchId,
      phone,
      flowKey,
      authorType: 'SYSTEM',
      authorName: 'Sistema',
      metadata: {
        protocolNumber,
        appointmentId: params.appointmentId,
        event: 'reschedule-request',
      },
      message: systemMessage,
    },
  });

  return {
    conversationId: conversation.id,
    protocolNumber,
    reusedProtocol: hasActiveProtocol,
  };
}

const extractMediaSummary = (payload: any): string => {
  return extractInboundMedia(payload).summary;
};

const extractInboundMessageText = (payload: any): string => {
  const candidates = [
    payload?.payload?.text,
    payload?.payload?.title,
    payload?.payload?.postbackText,
    payload?.payload?.reply,
    payload?.text,
    payload?.message?.text,
    payload?.message?.content?.text,
    payload?.content?.text,
    payload?.interactive?.button_reply?.title,
    payload?.interactive?.button_reply?.id,
    payload?.interactive?.list_reply?.title,
    payload?.interactive?.list_reply?.id,
    payload?.button?.text,
  ];

  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (text) return text;
  }

  return extractMediaSummary(payload);
};

const parseWebhookMessageEvent = (body: any, payload: any): 'SENT' | 'DELIVERED' | 'READ' | 'TYPING' | 'FAILED' | null => {
  const candidates = Array.from(collectStringCandidates([
    body?.type,
    payload?.type,
    payload?.payload?.type,
    payload?.status,
    payload?.eventType,
    payload?.message?.type,
  ]));

  for (const value of candidates) {
    if (value.includes('typing')) return 'TYPING';
    if (value.includes('failed') || value.includes('undeliver') || value.includes('reject')) return 'FAILED';
    if (value.includes('read')) return 'READ';
    if (value.includes('deliver')) return 'DELIVERED';
    if (value.includes('sent') || value.includes('submit')) return 'SENT';
  }

  return null;
};

export default async function whatsappWebhookRoutes(app: FastifyInstance) {
  app.get('/whatsapp/webhook/gupshup', async () => ({ ok: true }));

  app.post('/whatsapp/webhook/gupshup', {
    schema: {
      summary: 'Receive inbound Gupshup WhatsApp events',
      tags: ['WhatsApp'],
      body: {
        type: 'object',
        additionalProperties: true,
      },
      response: {
        200: {
          type: 'object',
          additionalProperties: true,
        },
      },
    },
  }, async (request) => {
    const body = request.body as any;
    const inboundPayload = body?.payload || {};
    const inboundMedia = extractInboundMedia(inboundPayload);
    
    const action = parseConfirmationAction(inboundPayload);
    const inboundText = extractInboundMessageText(inboundPayload);
    const source = normalizePhoneForConversation(inboundPayload?.source || inboundPayload?.sender?.phone || '');
    const messageEvent = parseWebhookMessageEvent(body, inboundPayload);

    request.log.info({
      gupshupEventType: body?.type || inboundPayload?.type || null,
      source: inboundPayload?.source || inboundPayload?.sender?.phone || null,
      contextGsId: inboundPayload?.context?.gsId || null,
      contextId: inboundPayload?.context?.id || null,
      confirmationAction: action,
      inboundText,
      inboundMedia: inboundMedia.metadata || null,
      payloadPreview: inboundPayload,
    }, 'Received WhatsApp webhook event');

    const quickReplyMessageId = inboundPayload?.payload?.id;
    const contextGsId = inboundPayload?.context?.gsId;
    const contextId = inboundPayload?.context?.id;
    const providerMessageId = String(
      inboundPayload?.gsId
      || inboundPayload?.id
      || inboundPayload?.messageId
      || contextGsId
      || contextId
      || '',
    ).trim();

    if (messageEvent && providerMessageId) {
      const statusTimestamp = new Date();

      const conversationMessage = await prisma.whatsAppConversationMessage.findFirst({
        where: { providerMessageId },
        include: { conversation: true },
      });

      if (conversationMessage?.conversation) {
        const eventLabel = messageEvent === 'READ'
          ? 'Mensagem lida pelo paciente.'
          : messageEvent === 'DELIVERED'
            ? 'Mensagem entregue ao paciente.'
            : messageEvent === 'FAILED'
              ? 'Falha de entrega retornada pelo provedor.'
            : messageEvent === 'SENT'
              ? 'Mensagem enviada ao provedor.'
              : 'Paciente está digitando.';
        const conversationMessageProtocol = String((conversationMessage.metadata as any)?.protocolNumber || '').trim()
          || String(conversationMessage.conversation?.humanProtocolNumber || '').trim()
          || null;

        await prisma.whatsAppConversationMessage.create({
          data: {
            conversationId: conversationMessage.conversationId,
            branchId: conversationMessage.branchId,
            phone: conversationMessage.phone,
            flowKey: conversationMessage.flowKey || null,
            authorType: 'SYSTEM',
            authorName: 'Webhook',
            metadata: {
              event: messageEvent,
              providerMessageId,
              ...(conversationMessageProtocol ? { protocolNumber: conversationMessageProtocol } : {}),
            },
            message: `[Evento] ${eventLabel}`,
          },
        });
      }

      const matchingLog = await prisma.whatsAppMessageLog.findFirst({
        where: {
          OR: [
            { providerMessageId },
            ...(source ? [{ patientPhone: { contains: source.slice(-11) } }] : []),
          ],
        },
        orderBy: { createdAt: 'desc' },
      });

      if (matchingLog) {
        const webhookError = String(
          inboundPayload?.errors?.[0]?.title
          || inboundPayload?.errors?.[0]?.code
          || inboundPayload?.payload?.errors?.[0]?.title
          || inboundPayload?.payload?.errors?.[0]?.code
          || inboundPayload?.reason
          || inboundPayload?.statusReason
          || '',
        ).trim() || null;

        await prisma.whatsAppMessageLog.update({
          where: { id: matchingLog.id },
          data: {
            ...(messageEvent === 'SENT' ? { sentAt: matchingLog.sentAt || statusTimestamp } : {}),
            ...(messageEvent === 'DELIVERED' ? { deliveredAt: statusTimestamp } : {}),
            ...(messageEvent === 'READ' ? { readAt: statusTimestamp } : {}),
            ...(messageEvent === 'READ' ? { status: 'READ' } : {}),
            ...(messageEvent === 'DELIVERED' ? { status: 'DELIVERED' } : {}),
            ...(messageEvent === 'FAILED' ? { status: 'FAILED' } : {}),
            ...(messageEvent === 'FAILED' ? { errorMessage: webhookError || 'Falha de entrega retornada pelo provedor.' } : {}),
            ...(messageEvent === 'SENT' ? { status: matchingLog.status === 'PENDING' ? 'SENT' : matchingLog.status } : {}),
          },
        });
      }

      if (!inboundText && !action) {
        return {
          success: true,
          event: messageEvent,
          providerMessageId,
        };
      }
    }

    let originatingLog = null as Awaited<ReturnType<typeof prisma.whatsAppMessageLog.findFirst>>;

    if (quickReplyMessageId) {
      originatingLog = await prisma.whatsAppMessageLog.findUnique({
        where: { id: quickReplyMessageId },
      });
    }

    if (!originatingLog && (contextGsId || contextId)) {
      originatingLog = await prisma.whatsAppMessageLog.findFirst({
        where: {
          messageType: 'APPOINTMENT_CONFIRMATION',
          providerMessageId: {
            in: [contextGsId, contextId].filter(Boolean) as string[],
          },
        },
      });
    }

    if (!originatingLog && source) {
      originatingLog = await prisma.whatsAppMessageLog.findFirst({
        where: {
          messageType: 'APPOINTMENT_CONFIRMATION',
          patientPhone: {
            contains: source.slice(-11),
          },
          status: {
            in: ['SENT', 'PENDING'],
          },
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (!action || !originatingLog?.appointmentId || !originatingLog.branchId) {
      if (source && inboundText) {
        const chatbotBranchHint = await resolveBranchHintFromPayload(body, source);
        const chatbotResult = await handleWhatsAppChatbot({
          phone: source,
          text: inboundText,
          metadata: inboundMedia.metadata || undefined,
          branchIdHint: chatbotBranchHint || undefined,
        });

        if (chatbotResult.handled) {
          return {
            success: true,
            chatbot: true,
          };
        }
      }

      request.log.warn({
        reason: action ? 'originating-log-not-found' : 'unsupported-action',
        source,
        contextGsId,
        contextId,
        payload: inboundPayload,
      }, 'Could not match WhatsApp webhook event to appointment confirmation log');
      return {
        success: true,
        ignored: true,
        reason: action ? 'originating-log-not-found' : 'unsupported-action',
      };
    }

    const appointment = await prisma.appointment.findFirst({
      where: {
        id: originatingLog.appointmentId,
        branchId: originatingLog.branchId,
      },
      select: {
        id: true,
        status: true,
        observations: true,
        patientId: true,
        patientName: true,
      },
    });

    if (!appointment) {
      return { success: true, ignored: true, reason: 'appointment-not-found' };
    }

    const nextLogStatus = action === 'CONFIRMED' ? 'RESPONDED_CONFIRMED' : 'RESPONDED_RESCHEDULE';
    if (CONFIRMATION_TERMINAL_STATUSES.has(String(originatingLog.status || '').trim().toUpperCase())) {
      await sendDecisionLockedGuidance({
        branchId: originatingLog.branchId,
        phone: source,
        message: 'Recebi sua resposta anteriormente e ela já foi registrada. Para escolher novamente, envie VOLTAR ou SAIR.',
      });
      return { success: true, ignored: true, reason: 'binary-decision-locked' };
    }

    const currentConversation = source
      ? await prisma.whatsAppConversation.findUnique({
        where: {
          branchId_phone: {
            branchId: originatingLog.branchId,
            phone: normalizePhoneForConversation(source),
          },
        },
        select: {
          id: true,
          humanStatus: true,
          humanFlowKey: true,
          humanProtocolNumber: true,
        },
      })
      : null;

    if (currentConversation?.humanStatus === 'ASSIGNED' || currentConversation?.humanStatus === 'CLOSED') {
      await sendDecisionLockedGuidance({
        branchId: originatingLog.branchId,
        phone: source,
        message: 'Este atendimento já está em andamento ou encerrado. Para iniciar um novo fluxo, envie VOLTAR ou SAIR.',
      });
      return {
        success: true,
        ignored: true,
        reason: 'blocked-by-human-flow',
        humanStatus: currentConversation.humanStatus,
      };
    }

    const timestamp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const rescheduleQueue = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.whatsAppMessageLog.update({
        where: { id: originatingLog!.id },
        data: {
          status: nextLogStatus,
        },
      });

      await tx.whatsAppMessageLog.updateMany({
        where: {
          id: { not: originatingLog!.id },
          branchId: originatingLog!.branchId,
          appointmentId: originatingLog!.appointmentId,
          messageType: 'APPOINTMENT_CONFIRMATION',
          status: { in: ['PENDING', 'SENT'] },
        },
        data: {
          status: nextLogStatus,
        },
      });

      if (action === 'CONFIRMED') {
        await tx.appointment.update({
          where: { id: appointment.id },
          data: {
            status: 'CONFIRMADO',
            observations: appendObservation(
              appointment.observations,
              `[WhatsApp] Agendamento confirmado pelo paciente em ${timestamp}.`,
            ),
          },
        });
        return null;
      }

      await tx.appointment.update({
        where: { id: appointment.id },
        data: {
          observations: appendObservation(
            appointment.observations,
            `[WhatsApp] Paciente solicitou reagendamento em ${timestamp}.`,
          ),
        },
      });

      return queueRescheduleHumanConversation(tx, {
        branchId: originatingLog.branchId,
        phone: source,
        appointmentId: appointment.id,
        patientId: appointment.patientId || null,
        patientName: appointment.patientName || null,
      });
    });

    await WhatsAppAutoSender.sendMessage({
      branchId: originatingLog.branchId,
      appointmentId: originatingLog.appointmentId,
      messageType: action === 'CONFIRMED'
        ? 'CONFIRMATION_REPLY_CONFIRMED'
        : 'CONFIRMATION_REPLY_RESCHEDULE',
    });

    request.log.info({
      action,
      appointmentId: originatingLog.appointmentId,
      originatingLogId: originatingLog.id,
      queueConversationId: rescheduleQueue?.conversationId || null,
      queueProtocolNumber: rescheduleQueue?.protocolNumber || null,
      queueReusedProtocol: rescheduleQueue?.reusedProtocol || false,
    }, 'Processed WhatsApp confirmation reply');

    return {
      success: true,
      action,
      appointmentId: originatingLog.appointmentId,
    };
  });
}
