import { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import WhatsAppAutoSender from '../lib/whatsapp-auto-sender';

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

const appendObservation = (existing: string | null | undefined, note: string) => {
  const trimmedExisting = String(existing || '').trim();
  return trimmedExisting ? `${trimmedExisting}\n${note}` : note;
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
    const action = parseConfirmationAction(inboundPayload);

    request.log.info({
      gupshupEventType: body?.type || inboundPayload?.type || null,
      source: inboundPayload?.source || inboundPayload?.sender?.phone || null,
      contextGsId: inboundPayload?.context?.gsId || null,
      contextId: inboundPayload?.context?.id || null,
      confirmationAction: action,
      payloadPreview: inboundPayload,
    }, 'Received WhatsApp webhook event');

    if (!action) {
      request.log.warn({
        reason: 'unsupported-action',
        payload: inboundPayload,
      }, 'Ignoring WhatsApp webhook event');
      return { success: true, ignored: true, reason: 'unsupported-action' };
    }

    const quickReplyMessageId = inboundPayload?.payload?.id;
    const contextGsId = inboundPayload?.context?.gsId;
    const contextId = inboundPayload?.context?.id;
    const source = String(inboundPayload?.source || inboundPayload?.sender?.phone || '').replace(/\D/g, '');

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

    if (!originatingLog?.appointmentId || !originatingLog.branchId) {
      request.log.warn({
        reason: 'originating-log-not-found',
        source,
        contextGsId,
        contextId,
        payload: inboundPayload,
      }, 'Could not match WhatsApp webhook event to appointment confirmation log');
      return { success: true, ignored: true, reason: 'originating-log-not-found' };
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
