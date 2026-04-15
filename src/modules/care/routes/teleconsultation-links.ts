import { randomBytes } from 'crypto';
import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';
import GupshupService from '../lib/gupshup';
import WhatsAppMessageBuilder from '../lib/whatsapp-message-builder';
import { resolveWhatsAppConfigForBranch } from '../lib/whatsapp-config-resolver';

const TELECONSULTATION_OBSERVATION_MARKER = '[MODALIDADE: TELECONSULTA]';
const RECEPTION_DONE_STATUS = 'RECEPCAO_CONCLUIDA';
const TELE_SIGNAL_TTL_MS = 20 * 60 * 1000;
const TELE_SIGNAL_MAX_PER_ROOM = 300;

type TeleRole = 'PATIENT' | 'DOCTOR';
type TeleSignalToRole = TeleRole | 'ALL';
type TeleSignalEventType =
  | 'doctor-joined'
  | 'ready'
  | 'offer'
  | 'answer'
  | 'ice'
  | 'hangup'
  | 'patient-left'
  | 'chat-message'
  | 'chat-file';

type TeleSignalEvent = {
  id: number;
  appointmentId: string;
  type: TeleSignalEventType;
  fromRole: TeleRole;
  toRole: TeleSignalToRole;
  payload: any;
  createdAt: string;
  createdAtMs: number;
};

const teleSignalRooms = new Map<string, TeleSignalEvent[]>();
let teleSignalSeq = 0;

const normalizeTeleRole = (value?: string | null): TeleRole | null => {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'PATIENT' || normalized === 'DOCTOR') return normalized;
  return null;
};

const normalizeTeleSignalType = (value?: string | null): TeleSignalEventType | null => {
  const normalized = String(value || '').trim().toLowerCase();
  if (
    normalized === 'doctor-joined'
    || normalized === 'ready'
    || normalized === 'offer'
    || normalized === 'answer'
    || normalized === 'ice'
    || normalized === 'hangup'
    || normalized === 'patient-left'
    || normalized === 'chat-message'
    || normalized === 'chat-file'
  ) {
    return normalized;
  }
  return null;
};

const normalizeTeleMessageType = (value?: string | null): 'TEXT' | 'FILE' | null => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'chat-message') return 'TEXT';
  if (normalized === 'chat-file') return 'FILE';
  return null;
};
const MAX_TELE_CHAT_TEXT_LENGTH = 1000;
const MAX_TELE_CHAT_FILE_DATA_URL_LENGTH = 3_000_000;

const pruneTeleSignalRoom = (appointmentId: string) => {
  const roomEvents = teleSignalRooms.get(appointmentId) || [];
  const minTime = Date.now() - TELE_SIGNAL_TTL_MS;
  const alive = roomEvents.filter((event) => event.createdAtMs >= minTime);
  const sliced = alive.slice(-TELE_SIGNAL_MAX_PER_ROOM);
  if (sliced.length === 0) {
    teleSignalRooms.delete(appointmentId);
    return;
  }
  teleSignalRooms.set(appointmentId, sliced);
};

const pushTeleSignal = (params: {
  appointmentId: string;
  type: TeleSignalEventType;
  fromRole: TeleRole;
  toRole?: TeleSignalToRole;
  payload?: any;
}) => {
  const now = new Date();
  const event: TeleSignalEvent = {
    id: ++teleSignalSeq,
    appointmentId: params.appointmentId,
    type: params.type,
    fromRole: params.fromRole,
    toRole: params.toRole || 'ALL',
    payload: params.payload ?? {},
    createdAt: now.toISOString(),
    createdAtMs: now.getTime(),
  };

  const roomEvents = teleSignalRooms.get(params.appointmentId) || [];
  roomEvents.push(event);
  teleSignalRooms.set(params.appointmentId, roomEvents);
  pruneTeleSignalRoom(params.appointmentId);
  return event;
};

const pullTeleSignals = (params: {
  appointmentId: string;
  role: TeleRole;
  afterId?: number;
  limit?: number;
}) => {
  pruneTeleSignalRoom(params.appointmentId);
  const roomEvents = teleSignalRooms.get(params.appointmentId) || [];
  const afterId = Number.isFinite(Number(params.afterId || 0)) ? Number(params.afterId || 0) : 0;
  const limit = Math.max(1, Math.min(Number(params.limit || 40), 100));

  const events = roomEvents
    .filter((event) => event.id > afterId)
    .filter((event) => event.fromRole !== params.role)
    .filter((event) => event.toRole === 'ALL' || event.toRole === params.role)
    .slice(-limit)
    .map((event) => ({
      id: event.id,
      type: event.type,
      fromRole: event.fromRole,
      toRole: event.toRole,
      payload: event.payload,
      createdAt: event.createdAt,
    }));

  const lastEventId = events.length > 0
    ? Number(events[events.length - 1].id || afterId)
    : afterId;

  return { events, lastEventId };
};

const normalizeStatus = (value?: string | null) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toUpperCase()
  .replace(/\s+/g, '_');

const normalizePhone = (value?: string | null) => String(value || '').replace(/\D/g, '');
const normalizePhoneForWhatsApp = (value?: string | null) => {
  let digits = normalizePhone(value);
  if (!digits.startsWith('55') && (digits.length === 10 || digits.length === 11)) {
    digits = `55${digits}`;
  }
  return digits;
};
const normalizeDateOnly = (value?: string | null) => String(value || '').slice(0, 10);
const resolvePreferredPhone = (...candidates: Array<string | null | undefined>) => {
  for (const candidate of candidates) {
    const normalized = normalizePhone(candidate);
    if (normalized) return normalized;
  }
  return '';
};

const resolveBranchWhatsAppConfig = async (branchId: string) => {
  const config = await resolveWhatsAppConfigForBranch(branchId, { requireActive: true, requireCredentials: true });
  if (!config) {
    throw new Error('Credenciais do WhatsApp não configuradas para envio da teleconsulta.');
  }

  return {
    apiKey: config.accountSid,
    appName: config.authToken,
    sourceNumber: config.fromNumber,
    sourceBranchId: config.sourceBranchId,
  };
};

const sendTeleconsultationWhatsAppMessage = async (params: {
  branchId: string;
  appointmentId?: string | null;
  patientPhone: string;
  patientName: string;
  patientUrl: string;
  doctorName?: string | null;
  specialty?: string | null;
  date?: string | null;
  time?: string | null;
  convenio?: string | null;
  clinicName?: string | null;
  notes?: string;
}) => {
  const config = await resolveBranchWhatsAppConfig(params.branchId);
  const gupshup = new GupshupService(config);

  const text = [
    `Olá ${params.patientName}!`,
    'Seu acesso para a teleconsulta foi liberado.',
    'Use este link para entrar na sala de espera:',
    params.patientUrl,
    params.notes ? `Observação: ${params.notes}` : null,
  ].filter(Boolean).join(' ');

  const templateBranchPriority = Array.from(new Set([
    String(config.sourceBranchId || '').trim(),
    String(params.branchId || '').trim(),
  ].filter(Boolean)));

  const templateCandidates = await prisma.whatsAppMessageTemplate.findMany({
    where: {
      branchId: { in: templateBranchPriority },
      type: 'TELECONSULTATION_LINK',
      isActive: true,
    },
    orderBy: [{ updatedAt: 'desc' }],
    select: {
      branchId: true,
      message: true,
      hsmTemplateId: true,
      hsmTemplateName: true,
      hsmTemplateApproved: true,
    },
  });

  const templateRecord = templateBranchPriority
    .map((candidateBranchId) => templateCandidates.find((item: any) => item.branchId === candidateBranchId))
    .find(Boolean) || null;

  if (!templateRecord) {
    throw new Error('Template "Link de Teleconsulta" não está ativo para esta filial.');
  }

  if (!templateRecord.hsmTemplateApproved || !(templateRecord.hsmTemplateId || templateRecord.hsmTemplateName)) {
    throw new Error('Template "Link de Teleconsulta" ainda não está aprovado/sincronizado na Gupshup.');
  }

  const hsmParams = WhatsAppMessageBuilder.extractTemplateParams(templateRecord.message, {
    patientName: params.patientName,
    doctorName: params.doctorName,
    professional: params.doctorName,
    specialty: params.specialty,
    date: params.date,
    time: params.time,
    convenio: params.convenio,
    clinicName: params.clinicName,
    location: params.clinicName,
    observations: params.notes || null,
    documentsLink: params.patientUrl,
  });

  const targetPhone = normalizePhoneForWhatsApp(params.patientPhone);
  const messageLog = await prisma.whatsAppMessageLog.create({
    data: {
      branchId: params.branchId,
      appointmentId: params.appointmentId || null,
      patientName: params.patientName || null,
      patientPhone: targetPhone,
      messageType: 'TELECONSULTATION_LINK',
      message: text,
      status: 'PENDING',
    },
  });

  const result = await gupshup.sendTemplateMessage({
    to: targetPhone,
    templateId: templateRecord.hsmTemplateId || templateRecord.hsmTemplateName!,
    params: hsmParams,
  });

  if (result.status !== 'success') {
    await prisma.whatsAppMessageLog.update({
      where: { id: messageLog.id },
      data: {
        status: 'FAILED',
        errorMessage: result.error || 'Falha ao enviar template de teleconsulta pelo WhatsApp.',
      },
    });
    throw new Error(result.error || 'Falha ao enviar template de teleconsulta pelo WhatsApp.');
  }

  await prisma.whatsAppMessageLog.update({
    where: { id: messageLog.id },
    data: {
      status: 'SENT',
      providerMessageId: result.messageId || null,
      sentAt: new Date(),
    },
  });

  return {
    provider: 'gupshup' as const,
    mode: 'HSM_TEMPLATE' as const,
    templateName: templateRecord.hsmTemplateName || null,
    templateId: templateRecord.hsmTemplateId || null,
    logId: messageLog.id,
    to: targetPhone,
    message: text,
    providerMessageId: result.messageId || null,
  };
};

const isTeleconsultationAppointment = (appointment: any) => {
  const appointmentType = String(appointment?.type || '').trim().toUpperCase();
  if (appointmentType === 'EXAME' || appointmentType === 'EXAM') return false;

  const observations = String(appointment?.observations || '').toUpperCase();
  return observations.includes(TELECONSULTATION_OBSERVATION_MARKER);
};

const getPublicBaseUrl = () => String(
  process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || 'http://localhost:5173',
).replace(/\/$/, '');

const getLoggedBranchId = async (request: any) => {
  const userId = (request.user as any)?.id;
  if (!userId) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { sector: { include: { branch: true } } },
  });

  return user?.sector?.branch?.id || null;
};

const buildTeleconsultationLinks = (
  app: FastifyInstance,
  payload: {
    appointmentId: string;
    preAttendanceId: string;
    branchId: string;
  },
) => {
  const expiresInSeconds = 12 * 60 * 60;
  const expiresAt = new Date(Date.now() + (expiresInSeconds * 1000)).toISOString();

  const patientToken = (app as any).jwt.sign({
    scope: 'teleconsultation_link',
    role: 'PATIENT',
    branchId: payload.branchId,
    appointmentId: payload.appointmentId,
    preAttendanceId: payload.preAttendanceId,
    nonce: randomBytes(12).toString('hex'),
  }, { expiresIn: expiresInSeconds });

  const doctorToken = (app as any).jwt.sign({
    scope: 'teleconsultation_link',
    role: 'DOCTOR',
    branchId: payload.branchId,
    appointmentId: payload.appointmentId,
    preAttendanceId: payload.preAttendanceId,
    nonce: randomBytes(12).toString('hex'),
  }, { expiresIn: expiresInSeconds });

  const baseUrl = getPublicBaseUrl();

  return {
    expiresAt,
    patientToken,
    doctorToken,
    patientUrl: `${baseUrl}/teleconsulta/preparacao?token=${encodeURIComponent(patientToken)}`,
    doctorUrl: `${baseUrl}/teleconsulta/preparacao?token=${encodeURIComponent(doctorToken)}`,
  };
};

const getPreAttendanceTeleconsultationContext = async (branchId: string, preAttendanceId: string) => {
  const preAttendance = await prisma.preAttendance.findFirst({
    where: { id: preAttendanceId, branchId, isActive: true },
  });

  if (!preAttendance) {
    return { error: 'Pré-atendimento não encontrado', statusCode: 404 as const };
  }

  if (!preAttendance.appointmentId) {
    return { error: 'Pré-atendimento sem agendamento vinculado', statusCode: 400 as const };
  }

  const appointment = await prisma.appointment.findFirst({
    where: { id: String(preAttendance.appointmentId), branchId, isActive: true },
  });

  if (!appointment) {
    return { error: 'Agendamento não encontrado', statusCode: 404 as const };
  }

  const linkedPatient = appointment.patientId
    ? await prisma.patient.findFirst({
        where: { id: appointment.patientId, branchId, isActive: true },
        select: { id: true, cellphone: true, phone: true, name: true },
      })
    : null;

  const attachmentsCount = await prisma.convenioAuthorizationAttachment.count({
    where: {
      branchId,
      sourceType: 'APPOINTMENT',
      appointmentId: appointment.id,
      isActive: true,
    },
  });

  const isTeleconsultation = isTeleconsultationAppointment(appointment);
  const isPreAttendanceComplete = normalizeStatus(preAttendance.status) === RECEPTION_DONE_STATUS;
  const isAuthorized = String(appointment.authorizationStatus || '').trim().toUpperCase() === 'AUTHORIZED';

  return {
    preAttendance,
    appointment,
    linkedPatient,
    attachmentsCount,
    isTeleconsultation,
    isPreAttendanceComplete,
    isAuthorized,
  };
};

const getAppointmentTeleconsultationContext = async (branchId: string, appointmentId: string) => {
  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, branchId, isActive: true },
  });

  if (!appointment) {
    return { error: 'Agendamento não encontrado', statusCode: 404 as const };
  }

  const flow = await prisma.preSchedulingFlow.findFirst({
    where: { appointmentId: appointment.id, branchId },
    include: {
      documents: { select: { id: true } },
    },
  });

  const linkedPatient = appointment.patientId
    ? await prisma.patient.findFirst({
        where: { id: appointment.patientId, branchId, isActive: true },
        select: { id: true, cellphone: true, phone: true, name: true },
      })
    : null;

  const preAttendance = await prisma.preAttendance.findFirst({
    where: {
      branchId,
      appointmentId: appointment.id,
      isActive: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  const convenioAttachmentsCount = await prisma.convenioAuthorizationAttachment.count({
    where: {
      branchId,
      sourceType: 'APPOINTMENT',
      appointmentId: appointment.id,
      isActive: true,
    },
  });

  const flowDocumentsCount = Array.isArray(flow?.documents) ? flow.documents.length : 0;
  const attachmentsCount = Math.max(convenioAttachmentsCount, flowDocumentsCount);
  const isTeleconsultation = isTeleconsultationAppointment(appointment);
  const isAuthorized = String(appointment.authorizationStatus || '').trim().toUpperCase() === 'AUTHORIZED';
  const flowStatus = String(flow?.status || '').trim().toUpperCase();
  const flowPreAuthorized = Boolean(flow?.preAuthorizedAt) || flowStatus === 'PRE_AUTHORIZED' || flowStatus === 'COMPLETED';

  return {
    appointment,
    flow,
    preAttendance,
    linkedPatient,
    attachmentsCount,
    isTeleconsultation,
    isAuthorized,
    flowPreAuthorized,
  };
};

const ensureConsultationInClinicalQueue = async (params: {
  branchId: string;
  appointment: any;
  preAttendance?: any;
  linkedPatient?: any;
}) => {
  const { branchId, appointment, preAttendance, linkedPatient } = params;
  const existing = await prisma.consultation.findFirst({
    where: { branchId, appointmentId: appointment.id, isActive: true },
    select: { id: true },
  });

  const agendaSummary = [
    appointment.time || '',
    appointment.specialty || '',
    appointment.doctorName || '',
  ].filter(Boolean).join(' • ');

  const baseData = {
    branchId,
    appointmentId: appointment.id,
    doctorId: preAttendance?.doctorId || null,
    doctorName: appointment.doctorName || preAttendance?.doctorName || null,
    patientName: appointment.patientName || preAttendance?.fullName || linkedPatient?.name || null,
    convenio: appointment.convenio || preAttendance?.convenio || null,
    convenioStatus: appointment.authorizationStatus || preAttendance?.convenioStatus || null,
    scheduledFor: `${normalizeDateOnly(appointment.date)} ${appointment.time || ''}`.trim() || null,
    queueType: 'Fila clínica',
    agenda: preAttendance?.agenda || agendaSummary || null,
    queue: 'Aguardando atendimento',
  };

  if (existing?.id) {
    await prisma.consultation.update({
      where: { id: existing.id },
      data: baseData,
    });
    return existing.id;
  }

  const created = await prisma.consultation.create({
    data: baseData,
  });
  return created.id;
};

export default async function teleconsultationLinksRoutes(app: FastifyInstance) {
  const verifyPublicToken = async (token: string) => {
    let payload: any = null;
    try {
      payload = (app as any).jwt.verify(token);
    } catch {
      return { error: 'Token inválido ou expirado', statusCode: 401 as const };
    }

    if (!payload || payload.scope !== 'teleconsultation_link') {
      return { error: 'Token inválido para teleconsulta', statusCode: 401 as const };
    }

    const tokenRole = normalizeTeleRole(String(payload.role || '').toUpperCase());
    if (!tokenRole) {
      return { error: 'Role inválida para teleconsulta', statusCode: 401 as const };
    }

    const appointment = await prisma.appointment.findFirst({
      where: {
        id: String(payload.appointmentId || ''),
        branchId: String(payload.branchId || ''),
        isActive: true,
      },
    });

    if (!appointment) {
      return { error: 'Agendamento não encontrado', statusCode: 404 as const };
    }

    if (!isTeleconsultationAppointment(appointment)) {
      return { error: 'Agendamento não habilitado para teleconsulta', statusCode: 403 as const };
    }

    return {
      payload,
      role: tokenRole,
      appointment,
    };
  };

  const resolvePublicToken = async (token: string, reply: any) => {
    const context = await verifyPublicToken(token);
    if ('error' in context) {
      return reply.code(context.statusCode).send({ error: context.error });
    }

    const { payload, role, appointment } = context;

    return reply.send({
      valid: true,
      role,
      appointment: {
        id: appointment.id,
        patientName: appointment.patientName || null,
        doctorName: appointment.doctorName || null,
        specialty: appointment.specialty || null,
        date: appointment.date || null,
        time: appointment.time || null,
      },
      room: {
        appointmentId: appointment.id,
      },
      window: {
        allowJoinFromMinutesBefore: 10,
      },
      tokenMeta: {
        expiresAt: payload?.exp ? new Date(Number(payload.exp) * 1000).toISOString() : null,
      },
    });
  };

  app.get('/pre-attendance/:preAttendanceId/eligibility', {
    preHandler: async (request) => { await request.jwtVerify(); },
    schema: {
      summary: 'Check if pre-attendance can send teleconsultation link',
      tags: ['Teleconsultation'],
      params: {
        type: 'object',
        required: ['preAttendanceId'],
        properties: {
          preAttendanceId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { preAttendanceId } = request.params as { preAttendanceId: string };
    const context = await getPreAttendanceTeleconsultationContext(branchId, preAttendanceId);

    if ('error' in context) {
      return reply.code(Number(context.statusCode || 400)).send({ error: context.error });
    }

    const reasons: string[] = [];

    if (!context.isTeleconsultation) reasons.push('Agendamento não está marcado como teleconsulta.');
    if (!context.isAuthorized) reasons.push('Agendamento ainda não está pré-autorizado.');
    if (!context.isPreAttendanceComplete) reasons.push('Checklist de recepção ainda não foi concluído.');

    return reply.send({
      preAttendanceId: context.preAttendance.id,
      appointmentId: context.appointment.id,
      isTeleconsultation: context.isTeleconsultation,
      isAuthorized: context.isAuthorized,
      isPreAttendanceComplete: context.isPreAttendanceComplete,
      attachmentsCount: context.attachmentsCount,
      canSendLink: reasons.length === 0,
      reasons,
      patientName: context.preAttendance.fullName || context.appointment.patientName || context.linkedPatient?.name || null,
      patientPhone: normalizePhone(context.linkedPatient?.cellphone || context.linkedPatient?.phone || context.preAttendance.phone || ''),
      doctorName: context.appointment.doctorName || context.preAttendance.doctorName || null,
      specialty: context.appointment.specialty || null,
      date: context.appointment.date || null,
      time: context.appointment.time || null,
    });
  });

  app.post('/pre-attendance/:preAttendanceId/send-whatsapp-link', {
    preHandler: async (request) => { await request.jwtVerify(); },
    schema: {
      summary: 'Generate secure teleconsultation links and send patient link (WhatsApp)',
      tags: ['Teleconsultation'],
      params: {
        type: 'object',
        required: ['preAttendanceId'],
        properties: {
          preAttendanceId: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          notes: { type: 'string' },
          sendPatientMessage: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { preAttendanceId } = request.params as { preAttendanceId: string };
    const { notes, sendPatientMessage = true } = (request.body || {}) as { notes?: string; sendPatientMessage?: boolean };
    const userId = String((request.user as any)?.id || '');

    const context = await getPreAttendanceTeleconsultationContext(branchId, preAttendanceId);
    if ('error' in context) {
      return reply.code(Number(context.statusCode || 400)).send({ error: context.error });
    }

    const reasons: string[] = [];
    if (!context.isTeleconsultation) reasons.push('Agendamento não está marcado como teleconsulta.');
    if (!context.isAuthorized) reasons.push('Agendamento ainda não está pré-autorizado.');
    if (!context.isPreAttendanceComplete) reasons.push('Checklist de recepção ainda não foi concluído.');

    if (reasons.length > 0) {
      return reply.code(400).send({
        error: 'Pré-requisitos da teleconsulta não atendidos',
        reasons,
      });
    }

    const links = buildTeleconsultationLinks(app, {
      appointmentId: context.appointment.id,
      preAttendanceId: context.preAttendance.id,
      branchId,
    });

    const patientName = context.preAttendance.fullName || context.appointment.patientName || context.linkedPatient?.name || 'paciente';
    const patientPhone = resolvePreferredPhone(
      context.preAttendance.phone,
      context.linkedPatient?.cellphone,
      context.linkedPatient?.phone,
    );
    if (!patientPhone) {
      return reply.code(400).send({ error: 'Paciente sem telefone válido para envio da teleconsulta.' });
    }

    const whatsapp = sendPatientMessage
      ? await sendTeleconsultationWhatsAppMessage({
        branchId,
        appointmentId: context.appointment.id,
        patientPhone,
        patientName,
        patientUrl: links.patientUrl,
        doctorName: context.appointment.doctorName || context.preAttendance.doctorName || null,
        specialty: context.appointment.specialty || null,
        date: context.appointment.date || null,
        time: context.appointment.time || null,
        convenio: context.appointment.convenio || null,
        notes,
      })
      : null;

    await prisma.preAttendance.update({
      where: { id: context.preAttendance.id },
      data: {
        notes: [
          String(context.preAttendance.notes || '').trim(),
          `[teleconsultation-link] ${new Date().toISOString()} user:${userId || 'unknown'} ${links.patientUrl}`,
        ].filter(Boolean).join('\n'),
      },
    });

    return reply.send({
      message: sendPatientMessage
        ? 'Link de teleconsulta gerado e enviado com sucesso'
        : 'Link de teleconsulta do médico gerado com sucesso',
      links: {
        patientUrl: links.patientUrl,
        doctorUrl: links.doctorUrl,
        expiresAt: links.expiresAt,
      },
      whatsapp: sendPatientMessage ? whatsapp : null,
    });
  });

  app.post('/appointment/:appointmentId/send-whatsapp-link', {
    preHandler: async (request) => { await request.jwtVerify(); },
    schema: {
      summary: 'Generate secure teleconsultation links (from pre-scheduling) and send patient link (WhatsApp)',
      tags: ['Teleconsultation'],
      params: {
        type: 'object',
        required: ['appointmentId'],
        properties: {
          appointmentId: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          notes: { type: 'string' },
          sendPatientMessage: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { appointmentId } = request.params as { appointmentId: string };
    const { notes, sendPatientMessage = true } = (request.body || {}) as { notes?: string; sendPatientMessage?: boolean };
    const userId = String((request.user as any)?.id || '');

    const context = await getAppointmentTeleconsultationContext(branchId, appointmentId);
    if ('error' in context) {
      return reply.code(Number(context.statusCode || 400)).send({ error: context.error });
    }

    const reasons: string[] = [];
    if (!context.isTeleconsultation) reasons.push('Agendamento não está marcado como teleconsulta.');
    if (!context.isAuthorized) reasons.push('Agendamento ainda não está pré-autorizado.');
    if (!context.flowPreAuthorized) reasons.push('Agendamento ainda não está pré-autorizado no pré-agendamento.');

    if (reasons.length > 0) {
      return reply.code(400).send({
        error: 'Pré-requisitos da teleconsulta não atendidos',
        reasons,
      });
    }

    const links = buildTeleconsultationLinks(app, {
      appointmentId: context.appointment.id,
      preAttendanceId: context.preAttendance?.id || context.flow?.id || context.appointment.id,
      branchId,
    });

    await ensureConsultationInClinicalQueue({
      branchId,
      appointment: context.appointment,
      preAttendance: context.preAttendance,
      linkedPatient: context.linkedPatient,
    });

    const patientName = context.appointment.patientName || context.flow?.patientName || context.preAttendance?.fullName || context.linkedPatient?.name || 'paciente';
    const patientPhone = resolvePreferredPhone(
      context.flow?.patientPhone,
      context.preAttendance?.phone,
      context.linkedPatient?.cellphone,
      context.linkedPatient?.phone,
    );
    if (sendPatientMessage && !patientPhone) {
      return reply.code(400).send({ error: 'Paciente sem telefone válido para envio da teleconsulta.' });
    }

    const whatsapp = sendPatientMessage
      ? await sendTeleconsultationWhatsAppMessage({
        branchId,
        appointmentId: context.appointment.id,
        patientPhone,
        patientName,
        patientUrl: links.patientUrl,
        doctorName: context.appointment.doctorName || context.preAttendance?.doctorName || null,
        specialty: context.appointment.specialty || null,
        date: context.appointment.date || null,
        time: context.appointment.time || null,
        convenio: context.appointment.convenio || null,
        notes,
      })
      : null;

    await prisma.preSchedulingFlow.updateMany({
      where: { appointmentId: context.appointment.id, branchId },
      data: {
        ...(sendPatientMessage && whatsapp?.message ? { linkMockMessage: whatsapp.message } : {}),
      },
    });

    if (context.preAttendance?.id) {
      await prisma.preAttendance.update({
        where: { id: context.preAttendance.id },
        data: {
          notes: [
            String(context.preAttendance.notes || '').trim(),
            `[teleconsultation-link] ${new Date().toISOString()} user:${userId || 'unknown'} ${links.patientUrl}`,
          ].filter(Boolean).join('\n'),
        },
      });
    }

    return reply.send({
      message: sendPatientMessage
        ? 'Link de teleconsulta gerado e enviado com sucesso'
        : 'Link de teleconsulta do médico gerado com sucesso',
      links: {
        patientUrl: links.patientUrl,
        doctorUrl: links.doctorUrl,
        expiresAt: links.expiresAt,
      },
      whatsapp: sendPatientMessage ? whatsapp : null,
    });
  });

  app.post('/public/signal', {
    schema: {
      summary: 'Publish teleconsultation signaling event',
      tags: ['Teleconsultation'],
      body: {
        type: 'object',
        required: ['token', 'type'],
        properties: {
          token: { type: 'string' },
          type: { type: 'string' },
          toRole: { type: 'string', enum: ['PATIENT', 'DOCTOR', 'ALL'] },
          payload: { type: 'object', additionalProperties: true },
        },
      },
    },
  }, async (request, reply) => {
    const { token, type, toRole, payload } = request.body as {
      token: string;
      type: string;
      toRole?: string;
      payload?: any;
    };

    const context = await verifyPublicToken(String(token || ''));
    if ('error' in context) {
      return reply.code(Number(context.statusCode || 400)).send({ error: context.error });
    }

    const signalType = normalizeTeleSignalType(type);
    if (!signalType) {
      return reply.code(400).send({ error: 'Tipo de sinal inválido' });
    }

    const targetRoleRaw = String(toRole || '').trim().toUpperCase();
    const targetRole = (targetRoleRaw === 'ALL' ? 'ALL' : normalizeTeleRole(targetRoleRaw)) || (
      context.role === 'DOCTOR' ? 'PATIENT' : 'DOCTOR'
    );

    const messageType = normalizeTeleMessageType(signalType);
    if (messageType) {
      const textPayload = String(payload?.text || '').trim();
      const fileNamePayload = String(payload?.fileName || '').trim();
      const fileMimeTypePayload = String(payload?.fileMimeType || '').trim();
      const fileDataUrlPayload = String(payload?.fileDataUrl || '').trim();
      const fileSizePayload = Number(payload?.fileSizeBytes || 0);

      if (messageType === 'TEXT' && textPayload.length === 0) {
        return reply.code(400).send({ error: 'Mensagem vazia não permitida' });
      }
      if (messageType === 'TEXT' && textPayload.length > MAX_TELE_CHAT_TEXT_LENGTH) {
        return reply.code(400).send({ error: 'Mensagem excede limite de tamanho' });
      }
      if (messageType === 'FILE' && (!fileNamePayload || !fileDataUrlPayload)) {
        return reply.code(400).send({ error: 'Arquivo inválido para chat' });
      }
      if (messageType === 'FILE' && fileDataUrlPayload.length > MAX_TELE_CHAT_FILE_DATA_URL_LENGTH) {
        return reply.code(400).send({ error: 'Arquivo excede limite de tamanho' });
      }

      await prisma.teleconsultationMessage.create({
        data: {
          branchId: context.appointment.branchId,
          appointmentId: context.appointment.id,
          fromRole: context.role,
          messageType,
          text: messageType === 'TEXT' ? textPayload : null,
          fileName: messageType === 'FILE' ? fileNamePayload : null,
          fileMimeType: messageType === 'FILE' ? fileMimeTypePayload : null,
          fileSizeBytes: messageType === 'FILE' && Number.isFinite(fileSizePayload)
            ? fileSizePayload
            : null,
          fileDataUrl: messageType === 'FILE' ? fileDataUrlPayload : null,
        },
      });
    }

    const created = pushTeleSignal({
      appointmentId: context.appointment.id,
      type: signalType,
      fromRole: context.role,
      toRole: targetRole,
      payload: payload ?? {},
    });

    return reply.send({
      ok: true,
      eventId: created.id,
    });
  });

  app.get('/public/signal', {
    schema: {
      summary: 'Pull teleconsultation signaling events',
      tags: ['Teleconsultation'],
      querystring: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string' },
          lastEventId: { type: 'number' },
          limit: { type: 'number' },
        },
      },
    },
  }, async (request, reply) => {
    const { token, lastEventId, limit } = request.query as {
      token: string;
      lastEventId?: number;
      limit?: number;
    };

    const context = await verifyPublicToken(String(token || ''));
    if ('error' in context) {
      return reply.code(Number(context.statusCode || 400)).send({ error: context.error });
    }

    const response = pullTeleSignals({
      appointmentId: context.appointment.id,
      role: context.role,
      afterId: Number(lastEventId || 0),
      limit: Number(limit || 40),
    });

    return reply.send(response);
  });

  app.get('/public/messages', {
    schema: {
      summary: 'List persisted teleconsultation chat messages',
      tags: ['Teleconsultation'],
      querystring: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
  }, async (request, reply) => {
    const { token, limit } = request.query as {
      token: string;
      limit?: number;
    };

    const context = await verifyPublicToken(String(token || ''));
    if ('error' in context) {
      return reply.code(Number(context.statusCode || 400)).send({ error: context.error });
    }

    const safeLimit = Math.max(1, Math.min(Number(limit || 100), 300));
    const rows = await prisma.teleconsultationMessage.findMany({
      where: {
        branchId: context.appointment.branchId,
        appointmentId: context.appointment.id,
      },
      orderBy: { createdAt: 'asc' },
      take: safeLimit,
    });

    return reply.send({
      items: rows.map((row: any) => ({
        id: row.id,
        fromRole: row.fromRole,
        kind: row.messageType === 'FILE' ? 'file' : 'text',
        text: row.text,
        fileName: row.fileName,
        fileMimeType: row.fileMimeType,
        fileSizeBytes: row.fileSizeBytes,
        fileDataUrl: row.fileDataUrl,
        createdAt: row.createdAt,
      })),
    });
  });

  app.get('/public/:token', {
    schema: {
      summary: 'Resolve public teleconsultation token',
      tags: ['Teleconsultation'],
      params: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { token } = request.params as { token: string };
    return resolvePublicToken(token, reply);
  });

  app.get('/public', {
    schema: {
      summary: 'Resolve public teleconsultation token (query)',
      tags: ['Teleconsultation'],
      querystring: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { token } = request.query as { token: string };
    return resolvePublicToken(String(token || ''), reply);
  });
}
