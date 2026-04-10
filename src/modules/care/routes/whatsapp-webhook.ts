import { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
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
  const source = findMediaCandidate(payload) || findMediaCandidate(payload?.payload) || findMediaCandidate(payload?.message);
  if (!source) return { summary: '' };

  const rawType = pickFirstString(source, ['type', 'mediaType', 'mimeType', 'mimetype']).toLowerCase();
  const mimeType = pickFirstString(source, ['mimeType', 'mimetype', 'contentType']) || rawType;
  const mediaUrl = pickFirstString(source, ['url', 'link', 'href', 'downloadUrl', 'mediaUrl', 'imageUrl', 'videoUrl', 'audioUrl']);
  const fileName = pickFirstString(source, ['caption', 'filename', 'fileName', 'name', 'title']);
  const mediaId = pickFirstString(source, ['mediaId', 'id']);

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
  };

  return { summary, metadata };
};

const appendObservation = (existing: string | null | undefined, note: string) => {
  const trimmedExisting = String(existing || '').trim();
  return trimmedExisting ? `${trimmedExisting}\n${note}` : note;
};

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

const parseWebhookMessageEvent = (body: any, payload: any): 'SENT' | 'DELIVERED' | 'READ' | 'TYPING' | null => {
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
    
    // Buscar URL da mídia se temos mediaId mas não temos URL
    if (inboundMedia.metadata?.mediaId && !inboundMedia.metadata?.mediaUrl) {
      try {
        // Tentar obter configuração do Gupshup das variáveis de ambiente
        if (process.env.GUPSHUP_API_KEY && process.env.GUPSHUP_APP_NAME && process.env.GUPSHUP_SOURCE_NUMBER) {
          const gupshup = new GupshupService({
            apiKey: String(process.env.GUPSHUP_API_KEY),
            appName: String(process.env.GUPSHUP_APP_NAME),
            sourceNumber: String(process.env.GUPSHUP_SOURCE_NUMBER),
          });
          const mediaData = await gupshup.getMediaUrl(String(inboundMedia.metadata.mediaId));
          if (mediaData?.url) {
            inboundMedia.metadata.mediaUrl = mediaData.url;
            request.log.info({ mediaId: inboundMedia.metadata.mediaId, mediaUrl: mediaData.url }, 'Fetched media URL from Gupshup');
          }
        }
      } catch (error) {
        request.log.error({ error, mediaId: inboundMedia.metadata.mediaId }, 'Failed to fetch media URL from Gupshup');
      }
    }
    
    const action = parseConfirmationAction(inboundPayload);
    const inboundText = extractInboundMessageText(inboundPayload);
    const source = String(inboundPayload?.source || inboundPayload?.sender?.phone || '').replace(/\D/g, '');
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
        await prisma.whatsAppMessageLog.update({
          where: { id: matchingLog.id },
          data: {
            ...(messageEvent === 'SENT' ? { sentAt: matchingLog.sentAt || statusTimestamp } : {}),
            ...(messageEvent === 'DELIVERED' ? { deliveredAt: statusTimestamp } : {}),
            ...(messageEvent === 'READ' ? { readAt: statusTimestamp } : {}),
            ...(messageEvent === 'READ' ? { status: 'READ' } : {}),
            ...(messageEvent === 'DELIVERED' ? { status: 'DELIVERED' } : {}),
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
        const chatbotResult = await handleWhatsAppChatbot({
          phone: source,
          text: inboundText,
          metadata: inboundMedia.metadata || undefined,
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
      },
    });

    if (!appointment) {
      return { success: true, ignored: true, reason: 'appointment-not-found' };
    }

    const nextLogStatus = action === 'CONFIRMED' ? 'RESPONDED_CONFIRMED' : 'RESPONDED_RESCHEDULE';
    if (originatingLog.status === nextLogStatus) {
      return { success: true, ignored: true, reason: 'already-processed' };
    }

    const timestamp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.whatsAppMessageLog.update({
        where: { id: originatingLog!.id },
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
        return;
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
    }, 'Processed WhatsApp confirmation reply');

    return {
      success: true,
      action,
      appointmentId: originatingLog.appointmentId,
    };
  });
}
