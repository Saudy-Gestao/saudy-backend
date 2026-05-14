import { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import prisma from '../lib/prisma';
import WhatsAppAutoSender from '../lib/whatsapp-auto-sender';
import handleWhatsAppChatbot from '../lib/whatsapp-chatbot';
import { createMessagingService } from '../lib/messaging';

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

const parseExamResultAction = (payload: any): 'SCHEDULE_FOLLOWUP' | 'LATER_FOLLOWUP' | null => {
  const candidates = Array.from(collectStringCandidates(payload));

  for (const value of candidates) {
    if (
      value.includes('schedule_followup')
      || value.includes('followup_yes')
      || value.includes('agendar_retorno')
      || value.includes('agendar retorno')
      || value.includes('retorno')
    ) return 'SCHEDULE_FOLLOWUP';
    if (
      value.includes('later_followup')
      || value.includes('followup_later')
      || value.includes('depois')
      || value.includes('mais tarde')
    ) return 'LATER_FOLLOWUP';
  }

  return null;
};

const CONFIRMATION_TERMINAL_STATUSES = new Set([
  'RESPONDED_CONFIRMED',
  'RESPONDED_RESCHEDULE',
]);

const EXAM_RESULT_TERMINAL_STATUSES = new Set([
  'RESPONDED_FOLLOWUP_SCHEDULE',
  'RESPONDED_FOLLOWUP_LATER',
]);

const NON_BLOCKING_APPOINTMENT_STATUSES = new Set([
  'CANCELADO',
  'CANCELED',
  'REALIZADO',
  'COMPLETED',
  'FINALIZADO',
  'NO_SHOW',
  'NAO_COMPARECEU',
  'AUSENTE',
  'FALTOU',
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
  // Try to find media in the standard Meta webhook structure first: payload.payload for inbound media
  let source = null;

  // Meta inbound media comes in payload.payload structure
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
      appId: true,
    },
  });

  const apiKey = whatsappConfig?.accountSid;
  const appName = whatsappConfig?.authToken;
  const sourceNumber = whatsappConfig?.fromNumber;
  const canUseBranchConfig = Boolean(whatsappConfig?.isActive && apiKey && appName && sourceNumber);

  if (!canUseBranchConfig) return;

  const messaging = createMessagingService({
    accountSid: apiKey,
    authToken: appName,
    fromNumber: sourceNumber,
    appId: whatsappConfig?.appId,
  });

  try {
    await messaging.sendTextMessage({
      to: normalizedPhone,
      message: params.message,
    });
  } catch {
    console.log('Failed to send guidance message via Meta');
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
    payload?.text?.body,
    payload?.text,
    payload?.message?.text,
    payload?.message?.content?.text,
    payload?.content?.text,
    payload?.interactive?.button_reply?.title,
    payload?.interactive?.button_reply?.id,
    payload?.interactive?.list_reply?.title,
    payload?.interactive?.list_reply?.id,
    payload?.interactive?.nfm_reply?.body,
    payload?.button?.text,
  ];

  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (text) return text;
  }

  return extractMediaSummary(payload);
};

const normalizeAppointmentStatusKey = (value?: string | null) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toUpperCase()
  .replace(/\s+/g, '_');

const parseTimeToMinutes = (value?: string | null) => {
  const match = String(value || '').trim().match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return (hours * 60) + minutes;
};

const rangesOverlap = (
  startA?: string | null,
  durationA?: number | null,
  startB?: string | null,
  durationB?: number | null,
) => {
  const startMinutesA = parseTimeToMinutes(startA);
  const startMinutesB = parseTimeToMinutes(startB);
  if (startMinutesA === null || startMinutesB === null) return false;
  const safeDurationA = Number.isFinite(Number(durationA)) && Number(durationA) > 0 ? Number(durationA) : 30;
  const safeDurationB = Number.isFinite(Number(durationB)) && Number(durationB) > 0 ? Number(durationB) : 30;
  const endA = startMinutesA + safeDurationA;
  const endB = startMinutesB + safeDurationB;
  return startMinutesA < endB && startMinutesB < endA;
};

const formatDateIso = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const isBusinessDay = (date: Date) => {
  const weekDay = date.getDay();
  return weekDay !== 0 && weekDay !== 6;
};

const addBusinessDays = (baseDate: Date, businessDays: number) => {
  let added = 0;
  const cursor = new Date(baseDate);
  cursor.setHours(0, 0, 0, 0);

  while (added < Math.max(0, businessDays)) {
    cursor.setDate(cursor.getDate() + 1);
    if (isBusinessDay(cursor)) added += 1;
  }

  return cursor;
};

const formatDatePtBr = (value?: string | null) => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
  const date = new Date(`${value}T00:00:00`);
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
};

const resolveFollowUpSpecialty = (sourceSpecialty?: string | null) => {
  const normalized = String(sourceSpecialty || '').trim();
  if (!normalized) return 'CONSULTA DE RETORNO';
  return `RETORNO ${normalized}`;
};

const findSuggestedFollowUpSlot = async (tx: Prisma.TransactionClient, params: {
  branchId: string;
  doctorName?: string | null;
  baseDate?: string | null;
  preferredTime?: string | null;
}) => {
  const normalizedDoctor = String(params.doctorName || '').trim();
  const preferredTime = /^\d{2}:\d{2}$/.test(String(params.preferredTime || '').trim())
    ? String(params.preferredTime || '')
    : '09:00';
  const base = params.baseDate && /^\d{4}-\d{2}-\d{2}$/.test(String(params.baseDate))
    ? new Date(`${params.baseDate}T00:00:00`)
    : new Date();
  const searchStart = addBusinessDays(base, 7);
  const timeCandidates = Array.from(new Set([preferredTime, '09:00', '10:00', '11:00', '14:00', '15:00', '16:00']));

  for (let dayOffset = 0; dayOffset < 45; dayOffset += 1) {
    const candidate = new Date(searchStart);
    candidate.setDate(searchStart.getDate() + dayOffset);
    if (!isBusinessDay(candidate)) continue;
    const dateIso = formatDateIso(candidate);

    const appointments = normalizedDoctor
      ? await tx.appointment.findMany({
          where: {
            branchId: params.branchId,
            date: dateIso,
            doctorName: { equals: normalizedDoctor, mode: 'insensitive' },
            isActive: true,
          },
          select: {
            time: true,
            durationMinutes: true,
            status: true,
          },
        })
      : [];

    const blocking = appointments.filter((item: any) => (
      !NON_BLOCKING_APPOINTMENT_STATUSES.has(normalizeAppointmentStatusKey(item?.status || ''))
    ));

    const availableTime = timeCandidates.find((time) => (
      !blocking.some((item: any) => rangesOverlap(time, 30, item?.time, item?.durationMinutes))
    ));
    if (!availableTime) continue;

    return {
      date: dateIso,
      time: availableTime,
      suggestionLabel: `${formatDatePtBr(dateIso) || dateIso} às ${availableTime}`,
    };
  }

  const fallbackDate = formatDateIso(searchStart);
  return {
    date: fallbackDate,
    time: preferredTime,
    suggestionLabel: `${formatDatePtBr(fallbackDate) || fallbackDate} às ${preferredTime}`,
  };
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

/**
 * Normalize a Meta v3 (Cloud API passthrough) webhook body into the same
 * shape as Meta v2 so the rest of the handler can treat them identically.
 *
 * v3 body:
 * { object: "whatsapp_business_account", entry: [{ changes: [{ value: { messages: [...], statuses: [...] } }] }] }
 */
function normalizeV3WebhookBody(v3Body: any): { normalizedBody: any; normalizedPayload: any; isV3Flow: boolean } {
  const value = v3Body?.entry?.[0]?.changes?.[0]?.value || {};
  const message = value?.messages?.[0] || null;
  const status = value?.statuses?.[0] || null;
  const contact = value?.contacts?.[0] || null;

  // Check if this is a Flow nfm_reply completion
  const isV3Flow = message?.interactive?.type === 'nfm_reply';

  if (status && !message) {
    // Delivery status event
    const normalizedPayload = {
      source: status.recipient_id || '',
      status: status.status, // sent / delivered / read / failed
      gsId: status.id,
      id: status.id,
      errors: status.errors || [],
    };
    return { normalizedBody: { type: `message_${status.status}` }, normalizedPayload, isV3Flow: false };
  }

  if (!message) {
    return { normalizedBody: v3Body, normalizedPayload: {}, isV3Flow: false };
  }

  const from = message.from || '';
  const msgId = message.id || '';
  const type = message.type || 'text';

  let textContent = '';
  let interactivePayload: Record<string, unknown> = {};
  let mediaPayload: Record<string, unknown> = {};

  if (type === 'text') {
    textContent = message.text?.body || '';
  } else if (type === 'interactive') {
    const interactive = message.interactive || {};
    const iType = interactive.type || '';
    if (iType === 'list_reply') {
      textContent = interactive.list_reply?.id || interactive.list_reply?.title || '';
    } else if (iType === 'button_reply') {
      textContent = interactive.button_reply?.id || interactive.button_reply?.title || '';
    } else if (iType === 'nfm_reply') {
      textContent = interactive.nfm_reply?.body || '';
    }
    interactivePayload = interactive;
  } else if (['image', 'video', 'audio', 'document'].includes(type)) {
    const mediaObj = message[type] || {};
    mediaPayload = {
      type,
      url: mediaObj.link || mediaObj.url || '',
      mimeType: mediaObj.mime_type || '',
      fileName: mediaObj.filename || mediaObj.caption || '',
      mediaId: mediaObj.id || '',
    };
  }

  const normalizedPayload = {
    source: from,
    gsId: msgId,
    id: msgId,
    type: type === 'text' ? 'text' : type,
    payload: {
      text: textContent,
      ...(Object.keys(mediaPayload).length > 0 ? mediaPayload : {}),
    },
    interactive: Object.keys(interactivePayload).length > 0 ? interactivePayload : undefined,
    sender: { phone: from, name: contact?.profile?.name || '' },
  };

  return { normalizedBody: { type: 'message' }, normalizedPayload, isV3Flow };
}

export default async function whatsappWebhookRoutes(app: FastifyInstance) {
  app.get('/whatsapp/webhook', async (request, reply) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = request.query as Record<string, string>;
    const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'saudy-webhook-token';
    if (mode === 'subscribe' && token === verifyToken) {
      return reply.send(challenge);
    }
    return reply.status(403).send({ ok: false });
  });

  app.post('/whatsapp/webhook', {
    schema: {
      summary: 'Receive inbound WhatsApp events',
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
    const rawBody = request.body as any;

    // Detect and normalize Meta v3 (Cloud API passthrough) format
    const isV3 = rawBody?.object === 'whatsapp_business_account';
    let body = rawBody;
    let inboundPayload: any;
    let isV3Flow = false;

    if (isV3) {
      const normalized = normalizeV3WebhookBody(rawBody);
      body = normalized.normalizedBody;
      inboundPayload = normalized.normalizedPayload;
      isV3Flow = normalized.isV3Flow;
    } else {
      inboundPayload = body?.payload || {};
    }

    // Handle v3 Flow completion (nfm_reply)
    // The appointment was already created by the /whatsapp/flow/exchange endpoint.
    // Here we just send a confirmation message and close the conversation.
    if (isV3Flow) {
      const message = rawBody?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      const nfmReply = message?.interactive?.nfm_reply;
      const from = normalizePhoneForConversation(message?.from || '');
      let flowData: Record<string, unknown> = {};
      try {
        flowData = JSON.parse(nfmReply?.response_json || '{}') as Record<string, unknown>;
      } catch { /* ignore */ }

      request.log.info({ from, flowAction: flowData?.flow_action, flowData }, 'WhatsApp Flow nfm_reply received');

      if (from) {
        const chatbotBranchHint = await resolveBranchHintFromPayload(rawBody, from);
        if (chatbotBranchHint) {
          const flowAction = String((flowData as any)?.extension_message_response?.params?.flow_action || flowData?.flow_action || '');

          if (flowAction === 'handoff') {
            // User selected "Não encontrei meu convênio/procedimento" — route to human
            const reason = String((flowData as any)?.extension_message_response?.params?.reason || 'HANDOFF');
            await handleWhatsAppChatbot({
              phone: from,
              text: `[FLOW_HANDOFF] ${reason}`,
              metadata: { flowData, source: 'whatsapp_flow' },
              branchIdHint: chatbotBranchHint,
            });
          } else if (flowAction === 'appointment_created') {
            // Appointment was already created by the exchange endpoint — just confirm to user
            const patientName = String((flowData as any)?.extension_message_response?.params?.patient_name || '');
            const procedureName = String((flowData as any)?.extension_message_response?.params?.procedure_name || '');
            const slotLabel = String((flowData as any)?.extension_message_response?.params?.slot_label || '');
            const greeting = patientName ? `Olá, ${patientName.split(' ')[0]}!` : 'Olá!';
            const confirmMsg = [
              `${greeting} ✅ Seu agendamento foi solicitado com sucesso!`,
              procedureName ? `Procedimento: ${procedureName}` : '',
              slotLabel ? `Horário sugerido: ${slotLabel}` : '',
              'A clínica confirmará em breve. Qualquer dúvida, é só nos chamar aqui!',
            ].filter(Boolean).join('\n');

            const waCfg = await prisma.whatsAppConfig.findUnique({
              where: { branchId: chatbotBranchHint },
              select: { accountSid: true, authToken: true, fromNumber: true, appId: true, isActive: true },
            });
            if (waCfg?.isActive && waCfg.accountSid) {
              const messaging = createMessagingService({
                accountSid: waCfg.accountSid,
                authToken: waCfg.authToken || undefined,
                fromNumber: waCfg.fromNumber || undefined,
                appId: waCfg.appId,
              });
              await messaging.sendTextMessage({ to: from, message: confirmMsg }).catch(() => null);
            }

            // Mark conversation as completed
            await handleWhatsAppChatbot({
              phone: from,
              text: '[FLOW_COMPLETE] appointment_created',
              metadata: { flowData, source: 'whatsapp_flow' },
              branchIdHint: chatbotBranchHint,
            });
          }
        }
      }

      return { success: true, flow: true };
    }

    const inboundMedia = extractInboundMedia(inboundPayload);
    const inboundText = extractInboundMessageText(inboundPayload);
    const confirmationAction = parseConfirmationAction(inboundPayload);
    const examResultAction = parseExamResultAction(inboundPayload);
    const action = confirmationAction || examResultAction;
    const source = normalizePhoneForConversation(inboundPayload?.source || inboundPayload?.sender?.phone || '');
    const messageEvent = parseWebhookMessageEvent(body, inboundPayload);

    // Status-only events (delivered/read/sent/failed) with no inbound text — skip chatbot immediately
    if (messageEvent && !inboundText && !inboundMedia.summary && !action) {
      return { success: true, event: messageEvent };
    }

    request.log.info({
      metaEventType: body?.type || inboundPayload?.type || null,
      source: inboundPayload?.source || inboundPayload?.sender?.phone || null,
      contextGsId: inboundPayload?.context?.gsId || null,
      contextId: inboundPayload?.context?.id || null,
      confirmationAction,
      examResultAction,
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

    const expectedMessageTypes = confirmationAction
      ? ['APPOINTMENT_CONFIRMATION']
      : examResultAction
        ? ['EXAM_REPORT_READY', 'APPOINTMENT_REMINDER']
        : ['APPOINTMENT_CONFIRMATION'];

    if (!originatingLog && (contextGsId || contextId)) {
      originatingLog = await prisma.whatsAppMessageLog.findFirst({
        where: {
          messageType: { in: expectedMessageTypes as any },
          providerMessageId: {
            in: [contextGsId, contextId].filter(Boolean) as string[],
          },
        },
      });
    }

    if (!originatingLog && source) {
      originatingLog = await prisma.whatsAppMessageLog.findFirst({
        where: {
          messageType: { in: expectedMessageTypes as any },
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
      if (source && (inboundText || inboundMedia.summary)) {
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
        patientCpf: true,
        doctorName: true,
        specialty: true,
        date: true,
        time: true,
        convenio: true,
      },
    });

    if (!appointment) {
      return { success: true, ignored: true, reason: 'appointment-not-found' };
    }

    const isConfirmationFlow = originatingLog.messageType === 'APPOINTMENT_CONFIRMATION';
    const isExamResultFlow = originatingLog.messageType === 'EXAM_REPORT_READY'
      || originatingLog.messageType === 'APPOINTMENT_REMINDER';
    const nextLogStatus = isConfirmationFlow
      ? (action === 'CONFIRMED' ? 'RESPONDED_CONFIRMED' : 'RESPONDED_RESCHEDULE')
      : (action === 'SCHEDULE_FOLLOWUP' ? 'RESPONDED_FOLLOWUP_SCHEDULE' : 'RESPONDED_FOLLOWUP_LATER');
    const terminalStatuses = isConfirmationFlow
      ? CONFIRMATION_TERMINAL_STATUSES
      : EXAM_RESULT_TERMINAL_STATUSES;
    if (terminalStatuses.has(String(originatingLog.status || '').trim().toUpperCase())) {
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

    const flowResult = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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
          messageType: originatingLog!.messageType,
          status: { in: ['PENDING', 'SENT'] },
        },
        data: {
          status: nextLogStatus,
        },
      });

      if (isConfirmationFlow && action === 'CONFIRMED') {
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
        return {
          flow: 'confirmation',
          rescheduleQueue: null,
          followUpAppointmentId: null,
          followUpSlotLabel: null,
          followUpCreated: false,
        };
      }

      if (isConfirmationFlow) {
        await tx.appointment.update({
          where: { id: appointment.id },
          data: {
            observations: appendObservation(
              appointment.observations,
              `[WhatsApp] Paciente solicitou reagendamento em ${timestamp}.`,
            ),
          },
        });

        const rescheduleQueue = await queueRescheduleHumanConversation(tx, {
          branchId: originatingLog.branchId,
          phone: source,
          appointmentId: appointment.id,
          patientId: appointment.patientId || null,
          patientName: appointment.patientName || null,
        });

        return {
          flow: 'confirmation',
          rescheduleQueue,
          followUpAppointmentId: null,
          followUpSlotLabel: null,
          followUpCreated: false,
        };
      }

      if (isExamResultFlow && action === 'SCHEDULE_FOLLOWUP') {
        const existingFollowUp = await tx.appointment.findFirst({
          where: {
            branchId: originatingLog.branchId,
            rescheduledFromAppointmentId: appointment.id,
            type: { in: ['CONSULTA', 'CONSULTATION'] },
            isActive: true,
            NOT: [
              { status: 'CANCELADO' },
              { status: 'CANCELED' },
              { status: 'NAO_COMPARECEU' },
              { status: 'NO_SHOW' },
              { status: 'AUSENTE' },
              { status: 'FALTOU' },
            ],
          },
          orderBy: { createdAt: 'desc' },
        });

        let followUp = existingFollowUp;
        let followUpCreated = false;
        if (!followUp) {
          const suggested = await findSuggestedFollowUpSlot(tx, {
            branchId: originatingLog.branchId,
            doctorName: appointment.doctorName || null,
            baseDate: appointment.date || null,
            preferredTime: appointment.time || null,
          });

          followUp = await tx.appointment.create({
            data: {
              branchId: originatingLog.branchId,
              rescheduledFromAppointmentId: appointment.id,
              patientName: appointment.patientName || null,
              patientCpf: appointment.patientCpf || null,
              patientId: appointment.patientId || null,
              doctorName: appointment.doctorName || null,
              specialty: resolveFollowUpSpecialty(appointment.specialty),
              convenio: appointment.convenio || null,
              date: suggested.date,
              time: suggested.time,
              durationMinutes: 30,
              type: 'CONSULTA',
              status: 'AGENDADO',
              observations: `[WhatsApp] Retorno agendado automaticamente em ${timestamp}. Origem exame:${appointment.id}`,
              requestedByDoctor: false,
              scheduledByDoctor: false,
            },
          });
          followUpCreated = true;
        }

        await tx.appointment.update({
          where: { id: appointment.id },
          data: {
            observations: appendObservation(
              appointment.observations,
              `[WhatsApp] Paciente solicitou agendamento de retorno em ${timestamp}.`,
            ),
          },
        });

        const followUpSlotLabel = followUp
          ? `${formatDatePtBr(followUp.date) || followUp.date || '-'} às ${followUp.time || '09:00'}`
          : null;

        return {
          flow: 'exam-result',
          rescheduleQueue: null,
          followUpAppointmentId: followUp?.id || null,
          followUpSlotLabel,
          followUpCreated,
        };
      }

      await tx.appointment.update({
        where: { id: appointment.id },
        data: {
          observations: appendObservation(
            appointment.observations,
            `[WhatsApp] Paciente preferiu agendar retorno depois (${timestamp}).`,
          ),
        },
      });

      return {
        flow: 'exam-result',
        rescheduleQueue: null,
        followUpAppointmentId: null,
        followUpSlotLabel: null,
        followUpCreated: false,
      };
    });

    if (isConfirmationFlow) {
      await WhatsAppAutoSender.sendMessage({
        branchId: originatingLog.branchId,
        appointmentId: originatingLog.appointmentId,
        messageType: action === 'CONFIRMED'
          ? 'CONFIRMATION_REPLY_CONFIRMED'
          : 'CONFIRMATION_REPLY_RESCHEDULE',
      });
    } else if (isExamResultFlow && action === 'SCHEDULE_FOLLOWUP') {
      const message = flowResult.followUpSlotLabel
        ? `Consulta de retorno ${flowResult.followUpCreated ? 'agendada' : 'já existente'} para ${flowResult.followUpSlotLabel}. Se precisar alterar, responda esta mensagem.`
        : 'Recebi sua confirmação e vamos providenciar seu retorno.';
      await WhatsAppAutoSender.sendMessage({
        branchId: originatingLog.branchId,
        appointmentId: flowResult.followUpAppointmentId || originatingLog.appointmentId,
        messageType: 'EXAM_REPORT_READY',
        customMessage: message,
        skipNotificationSettings: true,
      });
    } else if (isExamResultFlow) {
      await WhatsAppAutoSender.sendMessage({
        branchId: originatingLog.branchId,
        appointmentId: originatingLog.appointmentId,
        messageType: 'EXAM_REPORT_READY',
        customMessage: 'Sem problemas. Quando quiser, responda esta mensagem e ajudamos com seu retorno.',
        skipNotificationSettings: true,
      });
    }

    request.log.info({
      action,
      appointmentId: originatingLog.appointmentId,
      originatingLogId: originatingLog.id,
      flow: flowResult.flow,
      queueConversationId: flowResult.rescheduleQueue?.conversationId || null,
      queueProtocolNumber: flowResult.rescheduleQueue?.protocolNumber || null,
      queueReusedProtocol: flowResult.rescheduleQueue?.reusedProtocol || false,
      followUpAppointmentId: flowResult.followUpAppointmentId || null,
      followUpCreated: Boolean(flowResult.followUpCreated),
    }, 'Processed WhatsApp confirmation reply');

    return {
      success: true,
      action,
      appointmentId: originatingLog.appointmentId,
      followUpAppointmentId: flowResult.followUpAppointmentId || null,
      followUpSlot: flowResult.followUpSlotLabel || null,
    };
  });
}
