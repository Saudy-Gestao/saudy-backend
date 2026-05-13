import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { isValidCpf, normalizeCpf } from '../../../lib/cpf';
import { getAnexosStorage } from '../../../lib/storage';
import { sendPatientPortalAccessCodeEmail } from '../lib/mailer';

const PATIENT_CODE_EXPIRATION_MINUTES = 10;
const PATIENT_ACCESS_TOKEN_EXPIRATION = process.env.PATIENT_PORTAL_TOKEN_EXPIRES_IN || '12h';
const PUBLIC_FLOW_WINDOW_MINUTES = 30;
const REPORT_SHARE_LINK_DEFAULT_HOURS = Number(process.env.PATIENT_PORTAL_REPORT_SHARE_DEFAULT_HOURS || 72);
const REPORT_SHARE_LINK_MAX_HOURS = Number(process.env.PATIENT_PORTAL_REPORT_SHARE_MAX_HOURS || 168);
const REQUEST_CODE_WINDOW_MS = Number(process.env.PATIENT_PORTAL_REQUEST_CODE_WINDOW_MS || 15 * 60 * 1000);
const REQUEST_CODE_MAX_BY_IP = Number(process.env.PATIENT_PORTAL_REQUEST_CODE_MAX_BY_IP || 8);
const REQUEST_CODE_MAX_BY_CPF = Number(process.env.PATIENT_PORTAL_REQUEST_CODE_MAX_BY_CPF || 4);
const VERIFY_CODE_WINDOW_MS = Number(process.env.PATIENT_PORTAL_VERIFY_CODE_WINDOW_MS || 15 * 60 * 1000);
const VERIFY_CODE_MAX_BY_IP = Number(process.env.PATIENT_PORTAL_VERIFY_CODE_MAX_BY_IP || 30);
const VERIFY_CODE_MAX_ATTEMPTS_PER_CHALLENGE = Number(process.env.PATIENT_PORTAL_VERIFY_CODE_MAX_ATTEMPTS || 5);
const VERIFY_CODE_LOCK_MS = Number(process.env.PATIENT_PORTAL_VERIFY_CODE_LOCK_MS || 15 * 60 * 1000);
const CONFIRMED_APPOINTMENT_STATUSES = new Set(['CONFIRMADO', 'CONFIRMED']);
const PREPARATION_ALLOWED_APPOINTMENT_STATUSES = new Set(['AGENDADO', 'SCHEDULED', 'CONFIRMADO', 'CONFIRMED']);
const FINISHED_APPOINTMENT_STATUSES = new Set(['REALIZADO', 'COMPLETED', 'FINALIZADO', 'ATENDIDO']);
const CANCELED_APPOINTMENT_STATUSES = new Set(['CANCELADO', 'CANCELED', 'NAO_COMPARECEU', 'NO_SHOW', 'AUSENTE', 'FALTOU']);

const FINAL_REPORT_STATUSES = new Set([
  'FINALIZADO',
  'FINALIZADO_COM_REVISAO',
  'LIBERADO',
  'ASSINADO',
  'CONCLUIDO',
  'FINAL',
  'APROVADO',
]);

function hashCode(code: string) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function formatDateOnly(value?: Date | string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function normalizeDateInput(value: string) {
  const normalized = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return normalized;
}

function maskEmail(email?: string | null) {
  const raw = String(email || '').trim();
  if (!raw.includes('@')) return raw;
  const [name, domain] = raw.split('@');
  if (!name || !domain) return raw;
  if (name.length <= 2) {
    return `${name.slice(0, 1)}***@${domain}`;
  }
  return `${name.slice(0, 2)}***@${domain}`;
}

function normalizeReportStatus(value?: string | null) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');
}

function isVisibleToPatientReport(status?: string | null) {
  const normalized = normalizeReportStatus(status);
  if (!normalized) return false;
  return FINAL_REPORT_STATUSES.has(normalized);
}

function normalizeComparableText(value?: string | null) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function normalizeAppointmentStatus(value?: string | null) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
}

function isPatientInteractionCompleted(flow: any) {
  const status = normalizeAppointmentStatus(flow?.status);
  return status === 'DOCUMENTS_RECEIVED' || status === 'COMPLETED' || Boolean(flow?.patientSubmittedAt);
}

function isPublicFlowExpired(flow: any) {
  if (!flow?.patientAccessExpiresAt) return false;
  if (isPatientInteractionCompleted(flow)) return false;
  return new Date(flow.patientAccessExpiresAt).getTime() <= Date.now();
}

function makePublicToken() {
  return crypto.randomBytes(24).toString('hex');
}

function getPublicFlowUrl(token?: string | null) {
  if (!token) return null;
  const base = String(process.env.PUBLIC_APP_URL);
  return `${base}/pre-atendimento/documentos/${token}`;
}

function getPublicApiBaseUrl(request: any) {
  const envBase = String(
    process.env.PUBLIC_API_URL
    || process.env.API_PUBLIC_URL
    || process.env.BACKEND_PUBLIC_URL
    || '',
  ).trim();
  if (envBase) return envBase.replace(/\/+$/, '');
  const protocol = String(request?.protocol || 'http').trim();
  const host = String(request?.headers?.host || '').trim();
  return host ? `${protocol}://${host}` : '';
}

function getPublicReportShareUrl(request: any, token: string) {
  const base = getPublicApiBaseUrl(request);
  if (!base || !token) return null;
  return `${base}/auth/patient-portal/public/reports/${encodeURIComponent(token)}/pdf`;
}

function escapePdfText(value?: string | null) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r?\n/g, ' ');
}

function buildSimplePdfBuffer(title: string, lines: string[]) {
  const safeTitle = escapePdfText(title);
  const safeLines = lines.map((line) => escapePdfText(line)).filter(Boolean);
  const textCommands = [
    'BT',
    '/F1 18 Tf',
    '50 800 Td',
    `(${safeTitle}) Tj`,
    '/F1 11 Tf',
    '0 -28 Td',
    ...safeLines.flatMap((line, index) => ([
      index === 0 ? '' : '0 -18 Td',
      `(${line}) Tj`,
    ])).filter(Boolean),
    'ET',
  ].join('\n');

  const contentStream = Buffer.from(textCommands, 'utf-8');
  const objects: Buffer[] = [];
  const pushObject = (index: number, body: Buffer | string) => {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf-8');
    objects[index - 1] = Buffer.concat([
      Buffer.from(`${index} 0 obj\n`, 'utf-8'),
      payload,
      Buffer.from('\nendobj\n', 'utf-8'),
    ]);
  };

  pushObject(1, '<< /Type /Catalog /Pages 2 0 R >>');
  pushObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  pushObject(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>');
  pushObject(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pushObject(5, Buffer.concat([
    Buffer.from(`<< /Length ${contentStream.length} >>\nstream\n`, 'utf-8'),
    contentStream,
    Buffer.from('\nendstream', 'utf-8'),
  ]));

  const header = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary');
  let offset = header.length;
  const offsets = [0];
  const bodyBuffers: Buffer[] = [];
  for (const object of objects) {
    offsets.push(offset);
    bodyBuffers.push(object);
    offset += object.length;
  }

  const xrefStart = offset;
  const xrefLines = [
    `xref`,
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.slice(1).map((value) => `${String(value).padStart(10, '0')} 00000 n `),
  ].join('\n');

  const trailer = [
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefStart),
    '%%EOF',
  ].join('\n');

  return Buffer.concat([
    header,
    ...bodyBuffers,
    Buffer.from(`${xrefLines}\n`, 'utf-8'),
    Buffer.from(`${trailer}\n`, 'utf-8'),
  ]);
}

async function hasAnamnesisTemplateForAppointment(branchId: string | null, appointment: any) {
  if (!branchId || !appointment) return false;
  const appointmentType = normalizeAppointmentStatus(appointment?.type);
  if (appointmentType === 'EXAME' || appointmentType === 'EXAM') return false;

  const specialty = String(appointment?.specialty || '').trim();
  if (!specialty) return false;
  const normalizedSpecialty = normalizeComparableText(specialty);

  const procedures = await prisma.procedure.findMany({
    where: {
      branchId,
      isActive: true,
      OR: [
        { name: { equals: specialty, mode: 'insensitive' } },
        { name: { contains: specialty, mode: 'insensitive' } },
      ],
      anamnesisTemplates: {
        some: { isActive: true },
      },
    },
    include: {
      anamnesisTemplates: {
        where: { isActive: true },
        select: { id: true },
      },
    },
  });

  if (!procedures.length) return false;

  const matched = procedures.find((procedure: any) => {
    const procedureName = normalizeComparableText(procedure.name);
    return procedureName === normalizedSpecialty
      || procedureName.includes(normalizedSpecialty)
      || normalizedSpecialty.includes(procedureName);
  }) || procedures[0];

  return Array.isArray(matched?.anamnesisTemplates) && matched.anamnesisTemplates.length > 0;
}

type PatientPortalPayload = {
  scope: 'patient_portal';
  patientId: string;
  principalPatientId?: string;
  branchId: string | null;
  cpf: string;
  principalCpf?: string;
  allowedPatientIds?: string[];
};

type PatientPortalProfile = {
  id: string;
  branchId: string | null;
  name: string | null;
  cpf: string;
  birthDate: string | null;
  email: string | null;
  cellphone: string | null;
  relationship: string;
  profileType: 'SELF' | 'DEPENDENT';
  authorizationSource: 'OWNER' | 'GUARDIAN_CPF' | 'EXPLICIT_AUTHORIZATION';
  selected: boolean;
};

type PatientPortalAccessLogEvent =
  | 'REQUEST_CODE_SUCCESS'
  | 'REQUEST_CODE_INVALID_DATA'
  | 'REQUEST_CODE_PATIENT_NOT_FOUND'
  | 'REQUEST_CODE_BIRTHDATE_MISMATCH'
  | 'REQUEST_CODE_RATE_LIMITED'
  | 'REQUEST_CODE_EMAIL_MISSING'
  | 'REQUEST_CODE_EMAIL_FAILED'
  | 'VERIFY_CODE_SUCCESS'
  | 'VERIFY_CODE_INVALID_INPUT'
  | 'VERIFY_CODE_SESSION_EXPIRED'
  | 'VERIFY_CODE_SESSION_INVALID'
  | 'VERIFY_CODE_INVALID_CODE'
  | 'VERIFY_CODE_RATE_LIMITED'
  | 'VERIFY_CODE_BLOCKED';

type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

const requestCodeByIpWindow = new Map<string, number[]>();
const requestCodeByCpfWindow = new Map<string, number[]>();
const verifyCodeByIpWindow = new Map<string, number[]>();
const verifyChallengeAttempts = new Map<string, { attempts: number; lockedUntil: number; updatedAt: number }>();

function getClientIp(request: any) {
  const forwarded = String(request.headers?.['x-forwarded-for'] || '').split(',')[0]?.trim();
  const remote = String(request.ip || request.socket?.remoteAddress || '').trim();
  return forwarded || remote || 'unknown';
}

function consumeRateLimit(windowMap: Map<string, number[]>, key: string, max: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const previous = windowMap.get(key) || [];
  const active = previous.filter((timestamp) => timestamp > now - windowMs);
  if (active.length >= max) {
    const earliest = active[0] || now;
    const retryAfterSeconds = Math.max(1, Math.ceil((earliest + windowMs - now) / 1000));
    windowMap.set(key, active);
    return { allowed: false, retryAfterSeconds };
  }
  active.push(now);
  windowMap.set(key, active);
  return { allowed: true, retryAfterSeconds: 0 };
}

const getPatientFromPayload = async (payload: PatientPortalPayload) => {
  const where: any = { id: payload.patientId };
  if (payload.cpf) where.cpf = payload.cpf;
  if (payload.branchId) {
    where.branchId = payload.branchId;
  }

  return prisma.patient.findFirst({
    where,
    select: {
      id: true,
      branchId: true,
      name: true,
      cpf: true,
      birthDate: true,
      email: true,
      cellphone: true,
      phone: true,
      createdAt: true,
      isActive: true,
      hasHealthInsurance: true,
      healthInsuranceName: true,
    },
  });
};

const resolvePortalProfilesForPrincipal = async (principalPatient: any, activePatientId?: string | null): Promise<PatientPortalProfile[]> => {
  const principalCpf = normalizeCpf(principalPatient?.cpf || '');
  const principalId = String(principalPatient?.id || '');
  if (!principalId || !principalCpf) return [];

  const now = new Date();
  const [guardianDependents, explicitAuthorizations] = await Promise.all([
    prisma.patient.findMany({
      where: {
        isActive: true,
        id: { not: principalId },
        ...(principalPatient?.branchId ? { branchId: principalPatient.branchId } : {}),
        hasGuardian: true,
        guardianCpf: principalCpf,
      },
      select: {
        id: true,
        branchId: true,
        name: true,
        cpf: true,
        birthDate: true,
        email: true,
        cellphone: true,
        phone: true,
        guardianRelationship: true,
      },
    }),
    prisma.patientPortalDependentAuthorization.findMany({
      where: {
        status: 'ACTIVE',
        AND: [
          {
            OR: [
              { guardianPatientId: principalId },
              { guardianCpf: principalCpf },
            ],
          },
          {
            OR: [
              { expiresAt: null },
              { expiresAt: { gte: now } },
            ],
          },
        ],
        startsAt: { lte: now },
        revokedAt: null,
      },
      select: {
        dependentPatientId: true,
        relationship: true,
      },
      take: 300,
    }),
  ]);

  const explicitDependentIds = Array.from(new Set(
    explicitAuthorizations
      .map((item: any) => String(item?.dependentPatientId || '').trim())
      .filter(Boolean),
  ));

  const explicitDependents = explicitDependentIds.length > 0
    ? await prisma.patient.findMany({
      where: {
        isActive: true,
        id: { in: explicitDependentIds },
        ...(principalPatient?.branchId ? { branchId: principalPatient.branchId } : {}),
      },
      select: {
        id: true,
        branchId: true,
        name: true,
        cpf: true,
        birthDate: true,
        email: true,
        cellphone: true,
        phone: true,
      },
    })
    : [];

  const selectedId = String(activePatientId || principalId);
  const profilesById = new Map<string, PatientPortalProfile>();
  profilesById.set(principalId, {
    id: principalId,
    branchId: principalPatient.branchId || null,
    name: principalPatient.name || null,
    cpf: principalPatient.cpf,
    birthDate: formatDateOnly(principalPatient.birthDate),
    email: principalPatient.email || null,
    cellphone: principalPatient.cellphone || principalPatient.phone || null,
    relationship: 'Titular',
    profileType: 'SELF',
    authorizationSource: 'OWNER',
    selected: selectedId === principalId,
  });

  guardianDependents.forEach((dependent: any) => {
    const id = String(dependent.id || '').trim();
    if (!id) return;
    profilesById.set(id, {
      id,
      branchId: dependent.branchId || null,
      name: dependent.name || null,
      cpf: dependent.cpf,
      birthDate: formatDateOnly(dependent.birthDate),
      email: dependent.email || null,
      cellphone: dependent.cellphone || dependent.phone || null,
      relationship: String(dependent.guardianRelationship || 'Dependente'),
      profileType: 'DEPENDENT',
      authorizationSource: 'GUARDIAN_CPF',
      selected: selectedId === id,
    });
  });

  const explicitRelationshipById = new Map<string, string>();
  explicitAuthorizations.forEach((item: any) => {
    const dependentId = String(item?.dependentPatientId || '').trim();
    if (!dependentId || explicitRelationshipById.has(dependentId)) return;
    explicitRelationshipById.set(dependentId, String(item?.relationship || 'Dependente autorizado'));
  });

  explicitDependents.forEach((dependent: any) => {
    const id = String(dependent.id || '').trim();
    if (!id) return;
    const existing = profilesById.get(id);
    const relationship = explicitRelationshipById.get(id) || 'Dependente autorizado';
    if (existing) {
      profilesById.set(id, {
        ...existing,
        relationship: existing.relationship || relationship,
      });
      return;
    }
    profilesById.set(id, {
      id,
      branchId: dependent.branchId || null,
      name: dependent.name || null,
      cpf: dependent.cpf,
      birthDate: formatDateOnly(dependent.birthDate),
      email: dependent.email || null,
      cellphone: dependent.cellphone || dependent.phone || null,
      relationship,
      profileType: 'DEPENDENT',
      authorizationSource: 'EXPLICIT_AUTHORIZATION',
      selected: selectedId === id,
    });
  });

  return Array.from(profilesById.values())
    .sort((a, b) => {
      if (a.profileType === 'SELF' && b.profileType !== 'SELF') return -1;
      if (b.profileType === 'SELF' && a.profileType !== 'SELF') return 1;
      return String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR');
    })
    .map((profile) => ({ ...profile, selected: profile.id === selectedId }));
};

const buildReportPdfLines = (patient: any, report: any) => ([
  `Paciente: ${patient.name || report.patientName || '-'}`,
  `CPF: ${patient.cpf || report.cpf || '-'}`,
  `Exame: ${report.exam || report.appointment?.specialty || '-'}`,
  `Data/Hora: ${String(report.appointment?.date || '-')} ${String(report.appointment?.time || '')}`.trim(),
  `Médico solicitante: ${report.requestingDoctor || '-'}`,
  `Médico laudo: ${report.reportingDoctor || '-'}`,
  `Status: ${report.status || '-'}`,
  '---',
  `Descrição: ${report.description || '-'}`,
  `Conclusão: ${report.conclusion || '-'}`,
  `Observações: ${report.notes || '-'}`,
]);

function registerAccessEvent(request: any, params: {
  event: PatientPortalAccessLogEvent;
  status: 'SUCCESS' | 'FAILED' | 'BLOCKED' | 'RATE_LIMITED';
  message: string;
  branchId?: string | null;
  patientId?: string | null;
  cpf?: string | null;
}) {
  const ip = getClientIp(request);
  const cpf = params.cpf ? normalizeCpf(params.cpf) : null;
  void prisma.patientPortalAccessLog.create({
    data: {
      event: params.event,
      status: params.status,
      message: params.message,
      ipAddress: ip,
      userAgent: String(request.headers?.['user-agent'] || '').slice(0, 500) || null,
      branchId: params.branchId || null,
      patientId: params.patientId || null,
      cpf,
    },
  }).catch((error: any) => {
    request.log.error({ error }, 'Failed to persist patient portal access log');
  });
  request.log.info({
    event: 'patient_portal_access',
    action: params.event,
    status: params.status,
    patientId: params.patientId || null,
    cpf,
    ip,
    message: params.message,
  });
}

export default async function patientPortalRoutes(app: FastifyInstance) {
  const requirePatientPortalAuth = async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
      const payload = request.user as any;
      if (payload?.scope !== 'patient_portal' || !payload?.patientId) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      const normalized: PatientPortalPayload = {
        scope: 'patient_portal',
        patientId: String(payload.patientId || ''),
        principalPatientId: String(payload.principalPatientId || payload.patientId || ''),
        branchId: payload.branchId || null,
        cpf: String(payload.cpf || ''),
        principalCpf: String(payload.principalCpf || payload.cpf || ''),
        allowedPatientIds: Array.isArray(payload.allowedPatientIds)
          ? payload.allowedPatientIds.map((id: any) => String(id || '').trim()).filter(Boolean)
          : [String(payload.patientId || '').trim()].filter(Boolean),
      };
      if (!normalized.allowedPatientIds?.includes(normalized.patientId)) {
        normalized.allowedPatientIds = [normalized.patientId, ...(normalized.allowedPatientIds || [])]
          .map((id) => String(id || '').trim())
          .filter(Boolean);
      }
      return normalized;
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };

  app.post('/patient-portal/request-code', {
    schema: {
      summary: 'Request patient portal access code',
      tags: ['Auth'],
      body: {
        type: 'object',
        properties: {
          cpf: { type: 'string' },
          birthDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        },
        required: ['cpf', 'birthDate'],
      },
    },
  }, async (request, reply) => {
    const body = request.body as { cpf: string; birthDate: string };
    const cpf = normalizeCpf(body?.cpf);
    const birthDate = normalizeDateInput(body?.birthDate);
    const clientIp = getClientIp(request);

    const ipRate = consumeRateLimit(
      requestCodeByIpWindow,
      `request-code:ip:${clientIp}`,
      REQUEST_CODE_MAX_BY_IP,
      REQUEST_CODE_WINDOW_MS,
    );
    if (!ipRate.allowed) {
      registerAccessEvent(request, {
        event: 'REQUEST_CODE_RATE_LIMITED',
        status: 'RATE_LIMITED',
        message: `Limite de solicitações por IP. Tente novamente em ${ipRate.retryAfterSeconds}s.`,
        cpf: cpf || null,
      });
      return reply.code(429).send({
        error: 'Muitas tentativas. Aguarde alguns instantes antes de solicitar novo código.',
        retryAfterSeconds: ipRate.retryAfterSeconds,
      });
    }

    if (cpf) {
      const cpfRate = consumeRateLimit(
        requestCodeByCpfWindow,
        `request-code:cpf:${cpf}`,
        REQUEST_CODE_MAX_BY_CPF,
        REQUEST_CODE_WINDOW_MS,
      );
      if (!cpfRate.allowed) {
        registerAccessEvent(request, {
          event: 'REQUEST_CODE_RATE_LIMITED',
          status: 'RATE_LIMITED',
          message: `Limite de solicitações por CPF. Tente novamente em ${cpfRate.retryAfterSeconds}s.`,
          cpf,
        });
        return reply.code(429).send({
          error: 'Muitas tentativas para este CPF. Aguarde alguns instantes.',
          retryAfterSeconds: cpfRate.retryAfterSeconds,
        });
      }
    }

    if (!cpf || !isValidCpf(cpf) || !birthDate) {
      registerAccessEvent(request, {
        event: 'REQUEST_CODE_INVALID_DATA',
        status: 'FAILED',
        message: 'CPF ou data de nascimento inválidos.',
        cpf: cpf || null,
      });
      return reply.code(400).send({ error: 'CPF ou data de nascimento inválidos' });
    }

    const patient = await prisma.patient.findFirst({
      where: { cpf, isActive: true },
      select: {
        id: true,
        branchId: true,
        name: true,
        cpf: true,
        birthDate: true,
        email: true,
        cellphone: true,
        phone: true,
      },
    });

    if (!patient) {
      registerAccessEvent(request, {
        event: 'REQUEST_CODE_PATIENT_NOT_FOUND',
        status: 'FAILED',
        message: 'Paciente não encontrado para CPF informado.',
        cpf,
      });
      return reply.code(404).send({ error: 'Paciente não encontrado' });
    }

    const normalizedStoredBirthDate = formatDateOnly(patient.birthDate);
    if (!normalizedStoredBirthDate || normalizedStoredBirthDate !== birthDate) {
      registerAccessEvent(request, {
        event: 'REQUEST_CODE_BIRTHDATE_MISMATCH',
        status: 'FAILED',
        message: 'Data de nascimento não confere.',
        patientId: patient.id,
        cpf: patient.cpf,
      });
      return reply.code(401).send({ error: 'Dados de acesso inválidos' });
    }

    if (!patient.email) {
      registerAccessEvent(request, {
        event: 'REQUEST_CODE_EMAIL_MISSING',
        status: 'FAILED',
        message: 'Paciente sem e-mail cadastrado.',
        patientId: patient.id,
        cpf: patient.cpf,
      });
      return reply.code(400).send({
        error: 'Paciente sem e-mail cadastrado. Solicite atualização de cadastro na clínica.',
      });
    }

    const code = generateCode();
    const profiles = await resolvePortalProfilesForPrincipal(patient, patient.id);
    const allowedPatientIds = profiles.map((profile) => profile.id);
    const challengeToken = app.jwt.sign({
      scope: 'patient_portal_challenge',
      patientId: patient.id,
      principalPatientId: patient.id,
      branchId: patient.branchId || null,
      cpf: patient.cpf,
      principalCpf: patient.cpf,
      allowedPatientIds,
      codeHash: hashCode(code),
      requestIdentifier: crypto.randomUUID(),
    }, { expiresIn: `${PATIENT_CODE_EXPIRATION_MINUTES}m` });

    const sent = await sendPatientPortalAccessCodeEmail({
      to: patient.email,
      code,
      userName: patient.name || undefined,
    });

    if (!sent) {
      registerAccessEvent(request, {
        event: 'REQUEST_CODE_EMAIL_FAILED',
        status: 'FAILED',
        message: 'Falha ao enviar e-mail de código de acesso.',
        patientId: patient.id,
        cpf: patient.cpf,
      });
      return reply.code(500).send({ error: 'Serviço de e-mail não configurado para acesso do paciente' });
    }

    registerAccessEvent(request, {
      event: 'REQUEST_CODE_SUCCESS',
      status: 'SUCCESS',
      message: 'Código de acesso enviado com sucesso.',
      patientId: patient.id,
      cpf: patient.cpf,
    });

    return {
      message: 'Código enviado para o e-mail do paciente',
      challengeToken,
      destination: maskEmail(patient.email),
      expiresInMinutes: PATIENT_CODE_EXPIRATION_MINUTES,
      profiles: profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        relationship: profile.relationship,
        profileType: profile.profileType,
      })),
    };
  });

  app.post('/patient-portal/verify-code', {
    schema: {
      summary: 'Verify patient portal code',
      tags: ['Auth'],
      body: {
        type: 'object',
        properties: {
          challengeToken: { type: 'string' },
          code: { type: 'string' },
          selectedPatientId: { type: 'string' },
        },
        required: ['challengeToken', 'code'],
      },
    },
  }, async (request, reply) => {
    const { challengeToken, code, selectedPatientId } = request.body as { challengeToken: string; code: string; selectedPatientId?: string };
    const normalizedCode = String(code || '').trim();
    const clientIp = getClientIp(request);

    const verifyIpRate = consumeRateLimit(
      verifyCodeByIpWindow,
      `verify-code:ip:${clientIp}`,
      VERIFY_CODE_MAX_BY_IP,
      VERIFY_CODE_WINDOW_MS,
    );
    if (!verifyIpRate.allowed) {
      registerAccessEvent(request, {
        event: 'VERIFY_CODE_RATE_LIMITED',
        status: 'RATE_LIMITED',
        message: `Limite de validações por IP. Tente novamente em ${verifyIpRate.retryAfterSeconds}s.`,
      });
      return reply.code(429).send({
        error: 'Muitas validações de código em sequência. Aguarde alguns instantes.',
        retryAfterSeconds: verifyIpRate.retryAfterSeconds,
      });
    }

    if (!challengeToken || !/^\d{6}$/.test(normalizedCode)) {
      registerAccessEvent(request, {
        event: 'VERIFY_CODE_INVALID_INPUT',
        status: 'FAILED',
        message: 'Formato de código inválido.',
      });
      return reply.code(400).send({ error: 'Código inválido' });
    }

    let challengePayload: any;
    try {
      challengePayload = app.jwt.verify(challengeToken);
    } catch {
      registerAccessEvent(request, {
        event: 'VERIFY_CODE_SESSION_EXPIRED',
        status: 'FAILED',
        message: 'Sessão de verificação expirada.',
      });
      return reply.code(400).send({ error: 'Sessão de verificação expirada. Solicite um novo código.' });
    }

    if (challengePayload?.scope !== 'patient_portal_challenge' || !challengePayload?.patientId) {
      registerAccessEvent(request, {
        event: 'VERIFY_CODE_SESSION_INVALID',
        status: 'FAILED',
        message: 'Sessão de verificação inválida.',
      });
      return reply.code(400).send({ error: 'Sessão de verificação inválida' });
    }

    const challengeKey = String(challengePayload?.requestIdentifier || '');
    const challengeRecord = verifyChallengeAttempts.get(challengeKey) || { attempts: 0, lockedUntil: 0, updatedAt: Date.now() };
    if (challengeRecord.lockedUntil > Date.now()) {
      const retryAfterSeconds = Math.max(1, Math.ceil((challengeRecord.lockedUntil - Date.now()) / 1000));
      registerAccessEvent(request, {
        event: 'VERIFY_CODE_BLOCKED',
        status: 'BLOCKED',
        message: `Desafio temporariamente bloqueado por tentativas inválidas. Tente em ${retryAfterSeconds}s.`,
        patientId: String(challengePayload?.patientId || ''),
        cpf: String(challengePayload?.cpf || ''),
      });
      return reply.code(429).send({
        error: 'Muitas tentativas inválidas para este código. Solicite um novo código ou aguarde.',
        retryAfterSeconds,
      });
    }

    if (hashCode(normalizedCode) !== String(challengePayload.codeHash || '')) {
      const nextAttempts = (challengeRecord.attempts || 0) + 1;
      const lockedUntil = nextAttempts >= VERIFY_CODE_MAX_ATTEMPTS_PER_CHALLENGE ? Date.now() + VERIFY_CODE_LOCK_MS : 0;
      verifyChallengeAttempts.set(challengeKey, {
        attempts: nextAttempts,
        lockedUntil,
        updatedAt: Date.now(),
      });
      const remainingAttempts = Math.max(0, VERIFY_CODE_MAX_ATTEMPTS_PER_CHALLENGE - nextAttempts);
      registerAccessEvent(request, {
        event: 'VERIFY_CODE_INVALID_CODE',
        status: remainingAttempts > 0 ? 'FAILED' : 'BLOCKED',
        message: remainingAttempts > 0
          ? `Código inválido. Restam ${remainingAttempts} tentativa(s).`
          : 'Limite de tentativas atingido para este código.',
        patientId: String(challengePayload?.patientId || ''),
        cpf: String(challengePayload?.cpf || ''),
      });
      if (remainingAttempts <= 0) {
        return reply.code(429).send({
          error: 'Limite de tentativas atingido. Solicite um novo código.',
          retryAfterSeconds: Math.max(1, Math.ceil(VERIFY_CODE_LOCK_MS / 1000)),
        });
      }
      return reply.code(401).send({ error: 'Código inválido' });
    }

    const principalPatient = await prisma.patient.findFirst({
      where: {
        id: String(challengePayload.patientId),
        cpf: String(challengePayload.cpf || ''),
        isActive: true,
      },
      select: {
        id: true,
        branchId: true,
        name: true,
        cpf: true,
        birthDate: true,
        email: true,
        cellphone: true,
      },
    });

    if (!principalPatient) {
      registerAccessEvent(request, {
        event: 'VERIFY_CODE_SESSION_INVALID',
        status: 'FAILED',
        message: 'Paciente não encontrado/inativo durante validação.',
        patientId: String(challengePayload?.patientId || ''),
        cpf: String(challengePayload?.cpf || ''),
      });
      return reply.code(404).send({ error: 'Paciente não encontrado ou inativo' });
    }

    verifyChallengeAttempts.delete(challengeKey);

    const profiles = await resolvePortalProfilesForPrincipal(principalPatient, selectedPatientId || principalPatient.id);
    const allowedPatientIds = profiles.map((profile) => profile.id);
    if (!allowedPatientIds.includes(principalPatient.id)) {
      allowedPatientIds.unshift(principalPatient.id);
    }
    const normalizedSelectedPatientId = String(selectedPatientId || '').trim();
    const activePatientId = (normalizedSelectedPatientId && allowedPatientIds.includes(normalizedSelectedPatientId))
      ? normalizedSelectedPatientId
      : principalPatient.id;
    const activeProfile = profiles.find((profile) => profile.id === activePatientId)
      || profiles.find((profile) => profile.id === principalPatient.id)
      || null;
    if (!activeProfile) {
      return reply.code(403).send({ error: 'Nenhum perfil autorizado encontrado para este acesso.' });
    }

    const token = app.jwt.sign({
      scope: 'patient_portal',
      patientId: activeProfile.id,
      principalPatientId: principalPatient.id,
      branchId: activeProfile.branchId || principalPatient.branchId || null,
      cpf: activeProfile.cpf,
      principalCpf: principalPatient.cpf,
      allowedPatientIds,
    }, { expiresIn: PATIENT_ACCESS_TOKEN_EXPIRATION });

    registerAccessEvent(request, {
      event: 'VERIFY_CODE_SUCCESS',
      status: 'SUCCESS',
      message: 'Código validado e sessão iniciada.',
      patientId: principalPatient.id,
      cpf: principalPatient.cpf,
    });

    return {
      token,
      patient: {
        id: activeProfile.id,
        branchId: activeProfile.branchId || null,
        name: activeProfile.name || null,
        cpf: activeProfile.cpf,
        birthDate: activeProfile.birthDate || null,
        email: activeProfile.email || null,
        cellphone: activeProfile.cellphone || null,
        relationship: activeProfile.relationship,
        profileType: activeProfile.profileType,
      },
      profiles,
      principal: {
        id: principalPatient.id,
        name: principalPatient.name || null,
        cpf: principalPatient.cpf,
      },
    };
  });

  app.get('/patient-portal/me', {
    schema: {
      summary: 'Get current patient portal profile',
      tags: ['Auth'],
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;

    const patient = await getPatientFromPayload(payload);
    if (!patient) {
      return reply.code(404).send({ error: 'Paciente não encontrado' });
    }

    const [consultationsCount, examsCount, reportsRaw] = await Promise.all([
      prisma.appointment.count({
        where: {
          isActive: true,
          ...(patient.branchId ? { branchId: patient.branchId } : {}),
          OR: [
            { patientId: patient.id },
            { patientCpf: patient.cpf },
          ],
          type: { in: ['CONSULTA', 'CONSULTATION'] },
        },
      }),
      prisma.appointment.count({
        where: {
          isActive: true,
          ...(patient.branchId ? { branchId: patient.branchId } : {}),
          OR: [
            { patientId: patient.id },
            { patientCpf: patient.cpf },
          ],
          type: { in: ['EXAME', 'EXAM'] },
        },
      }),
      prisma.report.findMany({
        where: {
          isActive: true,
          ...(patient.branchId ? { branchId: patient.branchId } : {}),
          OR: [
            { cpf: patient.cpf },
            { appointment: { is: { patientId: patient.id } } },
            { appointment: { is: { patientCpf: patient.cpf } } },
          ],
        },
        select: { id: true, status: true },
        take: 500,
      }),
    ]);

    const reportsCount = reportsRaw.filter((item: any) => isVisibleToPatientReport(item?.status)).length;

    return {
      patient: {
        id: patient.id,
        name: patient.name,
        cpf: patient.cpf,
        birthDate: formatDateOnly(patient.birthDate),
        email: patient.email,
        cellphone: patient.cellphone || patient.phone || null,
      },
      stats: {
        consultationsCount,
        examsCount,
        reportsCount,
      },
      activeProfile: {
        patientId: patient.id,
        principalPatientId: payload.principalPatientId || payload.patientId,
        relationship: payload.patientId === (payload.principalPatientId || payload.patientId) ? 'Titular' : 'Dependente',
      },
    };
  });

  app.get('/patient-portal/me/profiles', {
    schema: {
      summary: 'List patient/dependent profiles available for this portal session',
      tags: ['Auth'],
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;

    const principalPayload: PatientPortalPayload = {
      ...payload,
      patientId: String(payload.principalPatientId || payload.patientId),
      cpf: String(payload.principalCpf || payload.cpf || ''),
    };
    const principalPatient = await getPatientFromPayload(principalPayload);
    if (!principalPatient) return reply.code(404).send({ error: 'Paciente titular não encontrado' });

    const profiles = await resolvePortalProfilesForPrincipal(principalPatient, payload.patientId);
    const allowed = new Set(payload.allowedPatientIds || []);
    const filteredProfiles = profiles.filter((profile) => allowed.size === 0 || allowed.has(profile.id));
    return {
      principalPatientId: principalPatient.id,
      activePatientId: payload.patientId,
      profiles: filteredProfiles,
    };
  });

  app.post('/patient-portal/me/select-profile', {
    schema: {
      summary: 'Select active profile (dependent/titular) for patient portal session',
      tags: ['Auth'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          patientId: { type: 'string' },
        },
        required: ['patientId'],
      },
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;

    const { patientId } = request.body as { patientId: string };
    const selectedPatientId = String(patientId || '').trim();
    if (!selectedPatientId) return reply.code(400).send({ error: 'Perfil inválido' });

    const principalPayload: PatientPortalPayload = {
      ...payload,
      patientId: String(payload.principalPatientId || payload.patientId),
      cpf: String(payload.principalCpf || payload.cpf || ''),
    };
    const principalPatient = await getPatientFromPayload(principalPayload);
    if (!principalPatient) return reply.code(404).send({ error: 'Paciente titular não encontrado' });

    const profiles = await resolvePortalProfilesForPrincipal(principalPatient, selectedPatientId);
    const allowedIds = (payload.allowedPatientIds || []).map((id: string) => String(id || '').trim()).filter(Boolean);
    const allowedSet = new Set(allowedIds.length > 0 ? allowedIds : profiles.map((profile) => profile.id));
    const selectedProfile = profiles.find((profile) => profile.id === selectedPatientId && allowedSet.has(profile.id));
    if (!selectedProfile) {
      return reply.code(403).send({ error: 'Este perfil não está autorizado para sua sessão.' });
    }

    const token = app.jwt.sign({
      scope: 'patient_portal',
      patientId: selectedProfile.id,
      principalPatientId: principalPatient.id,
      branchId: selectedProfile.branchId || principalPatient.branchId || null,
      cpf: selectedProfile.cpf,
      principalCpf: principalPatient.cpf,
      allowedPatientIds: Array.from(allowedSet),
    }, { expiresIn: PATIENT_ACCESS_TOKEN_EXPIRATION });

    return {
      token,
      patient: {
        id: selectedProfile.id,
        branchId: selectedProfile.branchId || null,
        name: selectedProfile.name || null,
        cpf: selectedProfile.cpf,
        birthDate: selectedProfile.birthDate || null,
        email: selectedProfile.email || null,
        cellphone: selectedProfile.cellphone || null,
        relationship: selectedProfile.relationship,
        profileType: selectedProfile.profileType,
      },
      profiles: profiles.filter((profile) => allowedSet.has(profile.id)),
      principal: {
        id: principalPatient.id,
        name: principalPatient.name || null,
        cpf: principalPatient.cpf,
      },
    };
  });

  app.get('/patient-portal/me/access-logs', {
    schema: {
      summary: 'List recent patient portal access logs',
      tags: ['Auth'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'number', default: 20 },
        },
      },
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;

    const patient = await getPatientFromPayload(payload);
    if (!patient) return reply.code(404).send({ error: 'Paciente não encontrado' });

    const { limit = 20 } = request.query as { limit?: number };
    const safeLimit = Math.max(1, Math.min(Number(limit || 20), 100));
    const where: any = {
      OR: [
        { patientId: patient.id },
        { cpf: patient.cpf },
      ],
    };
    if (patient.branchId) {
      where.AND = [
        {
          OR: [
            { branchId: patient.branchId },
            { branchId: null },
          ],
        },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.patientPortalAccessLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: safeLimit,
        select: {
          id: true,
          event: true,
          status: true,
          message: true,
          ipAddress: true,
          patientId: true,
          cpf: true,
          createdAt: true,
        },
      }),
      prisma.patientPortalAccessLog.count({ where }),
    ]);

    return {
      items: items.map((item: any) => ({
        id: item.id,
        event: item.event,
        status: item.status,
        message: item.message,
        ip: item.ipAddress,
        patientId: item.patientId || null,
        cpf: item.cpf || null,
        createdAt: item.createdAt,
      })),
      total,
    };
  });

  app.get('/patient-portal/me/documents', {
    schema: {
      summary: 'List central patient documents (attachments + pre-scheduling + reports)',
      tags: ['Auth'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;
    const patient = await getPatientFromPayload(payload);
    if (!patient) return reply.code(404).send({ error: 'Paciente não encontrado' });

    const { limit = 50, offset = 0 } = request.query as { limit?: number; offset?: number };

    const patientAppointmentWhere: any = {
      isActive: true,
      OR: [
        { patientId: patient.id },
        { patientCpf: patient.cpf },
      ],
    };
    if (patient.branchId) patientAppointmentWhere.branchId = patient.branchId;

    const [preSchedulingDocs, appointmentAttachments, reportsRaw] = await Promise.all([
      prisma.preSchedulingDocument.findMany({
        where: {
          flow: {
            appointment: patientAppointmentWhere,
          },
        },
        include: {
          flow: {
            select: {
              appointment: {
                select: {
                  id: true,
                  date: true,
                  time: true,
                  specialty: true,
                  status: true,
                  type: true,
                },
              },
            },
          },
        },
        orderBy: { uploadedAt: 'desc' },
        take: 300,
      }),
      prisma.appointmentAttachment.findMany({
        where: {
          isActive: true,
          ...(patient.branchId ? { branchId: patient.branchId } : {}),
          appointment: patientAppointmentWhere,
        },
        include: {
          appointment: {
            select: {
              id: true,
              date: true,
              time: true,
              specialty: true,
              status: true,
              type: true,
            },
          },
        },
        orderBy: { uploadedAt: 'desc' },
        take: 300,
      }),
      prisma.report.findMany({
        where: {
          isActive: true,
          ...(patient.branchId ? { branchId: patient.branchId } : {}),
          OR: [
            { cpf: patient.cpf },
            { appointment: { is: { patientId: patient.id } } },
            { appointment: { is: { patientCpf: patient.cpf } } },
          ],
        },
        select: {
          id: true,
          status: true,
          exam: true,
          updatedAt: true,
          createdAt: true,
          appointment: {
            select: {
              id: true,
              date: true,
              time: true,
              specialty: true,
              status: true,
              type: true,
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      }),
    ]);

    const reportItems = reportsRaw.filter((report: any) => isVisibleToPatientReport(report?.status));

    const mergedItems = [
      ...preSchedulingDocs.map((doc: any) => ({
        id: `pre-scheduling:${doc.id}`,
        source: 'pre-scheduling',
        sourceId: doc.id,
        fileName: doc.fileName,
        mimeType: doc.mimeType || 'application/octet-stream',
        sizeBytes: doc.sizeBytes || null,
        label: doc.documentType || 'Documento',
        uploadedAt: doc.uploadedAt,
        appointment: doc.flow?.appointment || null,
      })),
      ...appointmentAttachments.map((doc: any) => ({
        id: `appointment-attachment:${doc.id}`,
        source: 'appointment-attachment',
        sourceId: doc.id,
        fileName: doc.fileName,
        mimeType: doc.mimeType || 'application/octet-stream',
        sizeBytes: doc.sizeBytes || null,
        label: 'Anexo da consulta/exame',
        uploadedAt: doc.uploadedAt,
        appointment: doc.appointment || null,
      })),
      ...reportItems.map((report: any) => ({
        id: `report:${report.id}`,
        source: 'report',
        sourceId: report.id,
        fileName: `laudo-${report.id}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: null,
        label: report.exam || report.appointment?.specialty || 'Laudo',
        uploadedAt: report.updatedAt || report.createdAt,
        appointment: report.appointment || null,
      })),
    ]
      .sort((a: any, b: any) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());

    const paginated = mergedItems.slice(offset, offset + Math.max(1, Math.min(limit, 200)));
    return {
      items: paginated,
      total: mergedItems.length,
    };
  });

  app.get('/patient-portal/me/documents/:source/:documentId/view', {
    schema: {
      summary: 'View/download document from patient central',
      tags: ['Auth'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['pre-scheduling', 'appointment-attachment', 'report'] },
          documentId: { type: 'string' },
        },
        required: ['source', 'documentId'],
      },
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;
    const patient = await getPatientFromPayload(payload);
    if (!patient) return reply.code(404).send({ error: 'Paciente não encontrado' });

    const { source, documentId } = request.params as { source: string; documentId: string };
    const storageDoc = getAnexosStorage();

    if (source === 'pre-scheduling') {
      const document = await prisma.preSchedulingDocument.findFirst({
        where: {
          id: documentId,
          flow: {
            appointment: {
              isActive: true,
              ...(patient.branchId ? { branchId: patient.branchId } : {}),
              OR: [
                { patientId: patient.id },
                { patientCpf: patient.cpf },
              ],
            },
          },
        },
      });
      if (!document) return reply.code(404).send({ error: 'Documento não encontrado' });
      const exists = await storageDoc.exists(document.gcsObjectName);
      if (!exists) return reply.code(404).send({ error: 'Arquivo não encontrado no storage' });
      reply.header('Content-Type', document.mimeType || 'application/octet-stream');
      reply.header('Content-Disposition', `inline; filename="${document.fileName || 'documento'}"`);
      return reply.send(storageDoc.createReadStream(document.gcsObjectName));
    }

    if (source === 'appointment-attachment') {
      const attachment = await prisma.appointmentAttachment.findFirst({
        where: {
          id: documentId,
          isActive: true,
          ...(patient.branchId ? { branchId: patient.branchId } : {}),
          appointment: {
            isActive: true,
            OR: [
              { patientId: patient.id },
              { patientCpf: patient.cpf },
            ],
          },
        },
      });
      if (!attachment) return reply.code(404).send({ error: 'Anexo não encontrado' });
      const exists = await storageDoc.exists(attachment.gcsObjectName);
      if (!exists) return reply.code(404).send({ error: 'Arquivo não encontrado no storage' });
      reply.header('Content-Type', attachment.mimeType || 'application/octet-stream');
      reply.header('Content-Disposition', `inline; filename="${attachment.fileName || 'anexo'}"`);
      return reply.send(storageDoc.createReadStream(attachment.gcsObjectName));
    }

    if (source === 'report') {
      const report = await prisma.report.findFirst({
        where: {
          id: documentId,
          isActive: true,
          ...(patient.branchId ? { branchId: patient.branchId } : {}),
          OR: [
            { cpf: patient.cpf },
            { appointment: { is: { patientId: patient.id } } },
            { appointment: { is: { patientCpf: patient.cpf } } },
          ],
        },
        include: {
          appointment: {
            select: {
              date: true,
              time: true,
              specialty: true,
              doctorName: true,
            },
          },
        },
      });
      if (!report) return reply.code(404).send({ error: 'Laudo não encontrado' });
      if (!isVisibleToPatientReport(report.status)) {
        return reply.code(400).send({ error: 'Laudo ainda não liberado para download' });
      }
      const pdf = buildSimplePdfBuffer('Laudo Médico - Saudy', buildReportPdfLines(patient, report));
      const fileName = `laudo-${report.id}.pdf`;
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', `inline; filename="${fileName}"`);
      reply.header('Content-Length', String(pdf.length));
      return reply.send(pdf);
    }

    /* c8 ignore next */
    return reply.code(400).send({ error: 'Fonte de documento inválida' });
  });

  app.get('/patient-portal/me/consultations', {
    schema: {
      summary: 'List patient consultations',
      tags: ['Auth'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;

    const patient = await getPatientFromPayload(payload);
    if (!patient) return reply.code(404).send({ error: 'Paciente não encontrado' });

    const { limit = 50, offset = 0 } = request.query as { limit?: number; offset?: number };

    const where: any = {
      isActive: true,
      type: { in: ['CONSULTA', 'CONSULTATION'] },
      OR: [
        { patientId: patient.id },
        { patientCpf: patient.cpf },
      ],
    };
    if (patient.branchId) where.branchId = patient.branchId;

    const [items, total] = await Promise.all([
      prisma.appointment.findMany({
        where,
        orderBy: [{ date: 'desc' }, { time: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        skip: offset,
        select: {
          id: true,
          date: true,
          time: true,
          status: true,
          specialty: true,
          doctorName: true,
          type: true,
          convenio: true,
          observations: true,
          createdAt: true,
        },
      }),
      prisma.appointment.count({ where }),
    ]);

    return { items, total };
  });

  app.get('/patient-portal/me/exams', {
    schema: {
      summary: 'List patient exams',
      tags: ['Auth'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;

    const patient = await getPatientFromPayload(payload);
    if (!patient) return reply.code(404).send({ error: 'Paciente não encontrado' });

    const { limit = 50, offset = 0 } = request.query as { limit?: number; offset?: number };

    const where: any = {
      isActive: true,
      type: { in: ['EXAME', 'EXAM'] },
      OR: [
        { patientId: patient.id },
        { patientCpf: patient.cpf },
      ],
    };
    if (patient.branchId) where.branchId = patient.branchId;

    const [items, total] = await Promise.all([
      prisma.appointment.findMany({
        where,
        orderBy: [{ date: 'desc' }, { time: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        skip: offset,
        select: {
          id: true,
          date: true,
          time: true,
          status: true,
          specialty: true,
          doctorName: true,
          type: true,
          convenio: true,
          observations: true,
          accessionNumber: true,
          createdAt: true,
        },
      }),
      prisma.appointment.count({ where }),
    ]);

    return { items, total };
  });

  app.get('/patient-portal/me/upcoming-consultations', {
    schema: {
      summary: 'List patient upcoming consultations with pre-scheduling readiness',
      tags: ['Auth'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'number', default: 12 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;

    const patient = await getPatientFromPayload(payload);
    if (!patient) return reply.code(404).send({ error: 'Paciente não encontrado' });

    const { limit = 12, offset = 0 } = request.query as { limit?: number; offset?: number };
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const where: any = {
      isActive: true,
      type: { in: ['CONSULTA', 'CONSULTATION'] },
      OR: [
        { patientId: patient.id },
        { patientCpf: patient.cpf },
      ],
      date: { gte: today },
    };
    if (patient.branchId) where.branchId = patient.branchId;

    const [appointments, total] = await Promise.all([
      prisma.appointment.findMany({
        where,
        orderBy: [{ date: 'asc' }, { time: 'asc' }, { createdAt: 'desc' }],
        take: limit,
        skip: offset,
        include: {
          preSchedulingFlow: {
            include: {
              documents: { select: { id: true } },
              anamnesisResponse: { select: { id: true, submittedAt: true } },
            },
          },
        },
      }),
      prisma.appointment.count({ where }),
    ]);

    const items = await Promise.all(appointments.map(async (appointment: any) => {
      const normalizedStatus = normalizeAppointmentStatus(appointment.status);
      const flow = appointment.preSchedulingFlow || null;
      const hasAnamnesis = await hasAnamnesisTemplateForAppointment(patient.branchId, appointment);
      const isExpired = flow ? isPublicFlowExpired(flow) : false;
      const publicToken = !isExpired ? String(flow?.publicToken || '') : '';

      return {
        id: appointment.id,
        date: appointment.date || null,
        time: appointment.time || null,
        status: appointment.status || null,
        specialty: appointment.specialty || null,
        doctorName: appointment.doctorName || null,
        convenio: appointment.convenio || null,
        preScheduling: {
          hasAnamnesis,
          hasFlow: Boolean(flow),
          flowStatus: flow?.status || null,
          documentsCount: Array.isArray(flow?.documents) ? flow.documents.length : 0,
          anamnesisAnswered: Boolean(flow?.anamnesisResponse?.submittedAt),
          interactionCompleted: isPatientInteractionCompleted(flow),
          publicToken: publicToken || null,
          publicUrl: publicToken ? getPublicFlowUrl(publicToken) : null,
          canPrepare: (CONFIRMED_APPOINTMENT_STATUSES.has(normalizedStatus)
            || PREPARATION_ALLOWED_APPOINTMENT_STATUSES.has(normalizedStatus))
            && !FINISHED_APPOINTMENT_STATUSES.has(normalizedStatus)
            && !CANCELED_APPOINTMENT_STATUSES.has(normalizedStatus),
        },
      };
    }));

    return { items, total };
  });

  app.post('/patient-portal/me/upcoming-consultations/:appointmentId/pre-scheduling-link', {
    schema: {
      summary: 'Get or create pre-scheduling public link for patient upcoming consultation',
      tags: ['Auth'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: { appointmentId: { type: 'string' } },
        required: ['appointmentId'],
      },
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;

    const patient = await getPatientFromPayload(payload);
    if (!patient) return reply.code(404).send({ error: 'Paciente não encontrado' });

    const { appointmentId } = request.params as { appointmentId: string };

    const appointment = await prisma.appointment.findFirst({
      where: {
        id: appointmentId,
        isActive: true,
        ...(patient.branchId ? { branchId: patient.branchId } : {}),
        OR: [
          { patientId: patient.id },
          { patientCpf: patient.cpf },
        ],
      },
      include: {
        preSchedulingFlow: {
          include: {
            documents: { select: { id: true } },
            anamnesisResponse: { select: { id: true, submittedAt: true } },
          },
        },
      },
    });

    if (!appointment) {
      return reply.code(404).send({ error: 'Consulta não encontrada' });
    }

    const normalizedStatus = normalizeAppointmentStatus(appointment.status);
    if (!PREPARATION_ALLOWED_APPOINTMENT_STATUSES.has(normalizedStatus)) {
      return reply.code(400).send({ error: 'A consulta precisa estar agendada ou confirmada para preencher preparo/anamnese' });
    }

    const now = new Date();
    const hasAnamnesis = await hasAnamnesisTemplateForAppointment(patient.branchId, appointment);
    let flow = appointment.preSchedulingFlow;

    if (!flow) {
      flow = await prisma.preSchedulingFlow.create({
        data: {
          branchId: patient.branchId,
          appointmentId: appointment.id,
          patientId: patient.id,
          patientName: patient.name || appointment.patientName || null,
          patientCpf: patient.cpf,
          patientPhone: patient.cellphone || patient.phone || null,
          publicToken: makePublicToken(),
          status: 'WAITING_PATIENT_DOCUMENTS',
          linkSentAt: now,
          anamnesisSentAt: hasAnamnesis ? now : null,
        },
        include: {
          documents: { select: { id: true } },
          anamnesisResponse: { select: { id: true, submittedAt: true } },
        },
      });
    } else {
      const expired = isPublicFlowExpired(flow);
      const needsNewToken = expired || !flow.publicToken;

      flow = await prisma.preSchedulingFlow.update({
        where: { id: flow.id },
        data: {
          status: isPatientInteractionCompleted(flow) ? flow.status : 'WAITING_PATIENT_DOCUMENTS',
          publicToken: needsNewToken ? makePublicToken() : flow.publicToken,
          linkSentAt: needsNewToken ? now : flow.linkSentAt || now,
          patientVerifiedAt: needsNewToken ? null : flow.patientVerifiedAt,
          patientVerifiedCpf: needsNewToken ? null : flow.patientVerifiedCpf,
          patientVerifiedName: needsNewToken ? null : flow.patientVerifiedName,
          patientVerifiedTrust: needsNewToken ? null : flow.patientVerifiedTrust,
          patientAccessExpiresAt: needsNewToken ? null : flow.patientAccessExpiresAt,
          patientSubmittedAt: needsNewToken ? null : flow.patientSubmittedAt,
          anamnesisSentAt: hasAnamnesis && !flow.anamnesisSentAt ? now : flow.anamnesisSentAt,
        },
        include: {
          documents: { select: { id: true } },
          anamnesisResponse: { select: { id: true, submittedAt: true } },
        },
      });
    }

    return {
      appointmentId: appointment.id,
      publicToken: flow.publicToken,
      publicUrl: getPublicFlowUrl(flow.publicToken),
      hasAnamnesis,
      flowStatus: flow.status,
      documentsCount: Array.isArray(flow.documents) ? flow.documents.length : 0,
      anamnesisAnswered: Boolean(flow.anamnesisResponse?.submittedAt),
      interactionCompleted: isPatientInteractionCompleted(flow),
      expiresAt: flow.patientAccessExpiresAt || null,
    };
  });

  app.get('/patient-portal/me/reports', {
    schema: {
      summary: 'List patient reports',
      tags: ['Auth'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;

    const patient = await getPatientFromPayload(payload);
    if (!patient) return reply.code(404).send({ error: 'Paciente não encontrado' });

    const { limit = 50, offset = 0 } = request.query as { limit?: number; offset?: number };

    const where: any = {
      isActive: true,
      OR: [
        { cpf: patient.cpf },
        { appointment: { is: { patientId: patient.id } } },
        { appointment: { is: { patientCpf: patient.cpf } } },
      ],
    };
    if (patient.branchId) where.branchId = patient.branchId;

    const [rawItems, totalRaw] = await Promise.all([
      prisma.report.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
        take: Math.max(limit * 3, limit),
        skip: offset,
        include: {
          appointment: {
            select: {
              id: true,
              date: true,
              time: true,
              specialty: true,
              doctorName: true,
              type: true,
              status: true,
            },
          },
          worklistItem: {
            select: {
              id: true,
              dicomUrl: true,
              dicomStudyUid: true,
              dicomReceivedAt: true,
            },
          },
        },
      }),
      prisma.report.count({ where }),
    ]);

    const items = rawItems.filter((item: any) => isVisibleToPatientReport(item?.status)).slice(0, limit);

    return { items, total: totalRaw };
  });

  app.post('/patient-portal/me/reports/:reportId/share-link', {
    schema: {
      summary: 'Generate secure share link for patient report',
      tags: ['Auth'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: { reportId: { type: 'string' } },
        required: ['reportId'],
      },
      body: {
        type: 'object',
        properties: {
          expiresInHours: { type: 'number' },
        },
      },
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;

    const patient = await getPatientFromPayload(payload);
    if (!patient) return reply.code(404).send({ error: 'Paciente não encontrado' });

    const { reportId } = request.params as { reportId: string };
    const body = (request.body || {}) as { expiresInHours?: number };
    const requestedHours = Number(body.expiresInHours);
    const expiresInHours = Number.isFinite(requestedHours)
      ? Math.min(Math.max(Math.floor(requestedHours), 1), REPORT_SHARE_LINK_MAX_HOURS)
      : REPORT_SHARE_LINK_DEFAULT_HOURS;

    const report = await prisma.report.findFirst({
      where: {
        id: reportId,
        isActive: true,
        ...(patient.branchId ? { branchId: patient.branchId } : {}),
        OR: [
          { cpf: patient.cpf },
          { appointment: { is: { patientId: patient.id } } },
          { appointment: { is: { patientCpf: patient.cpf } } },
        ],
      },
    });

    if (!report) return reply.code(404).send({ error: 'Laudo não encontrado' });
    if (!isVisibleToPatientReport(report.status)) {
      return reply.code(400).send({ error: 'Laudo ainda não liberado para compartilhamento' });
    }

    const expiresAt = new Date(Date.now() + (expiresInHours * 60 * 60 * 1000));
    const token = app.jwt.sign({
      scope: 'patient_report_share',
      reportId: report.id,
      patientId: patient.id,
      cpf: patient.cpf,
      branchId: patient.branchId || null,
    }, { expiresIn: `${expiresInHours}h` });

    const url = getPublicReportShareUrl(request, token);
    if (!url) {
      return reply.code(500).send({ error: 'Não foi possível montar o link público de compartilhamento' });
    }

    return {
      reportId: report.id,
      url,
      expiresAt: expiresAt.toISOString(),
      expiresInHours,
    };
  });

  app.get('/patient-portal/me/reports/:reportId/pdf', {
    schema: {
      summary: 'Download patient report as PDF',
      tags: ['Auth'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: { reportId: { type: 'string' } },
        required: ['reportId'],
      },
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;

    const patient = await getPatientFromPayload(payload);
    if (!patient) return reply.code(404).send({ error: 'Paciente não encontrado' });

    const { reportId } = request.params as { reportId: string };
    const report = await prisma.report.findFirst({
      where: {
        id: reportId,
        isActive: true,
        ...(patient.branchId ? { branchId: patient.branchId } : {}),
        OR: [
          { cpf: patient.cpf },
          { appointment: { is: { patientId: patient.id } } },
          { appointment: { is: { patientCpf: patient.cpf } } },
        ],
      },
      include: {
        appointment: {
          select: {
            date: true,
            time: true,
            specialty: true,
            doctorName: true,
          },
        },
      },
    });

    if (!report) return reply.code(404).send({ error: 'Laudo não encontrado' });
    if (!isVisibleToPatientReport(report.status)) {
      return reply.code(400).send({ error: 'Laudo ainda não liberado para download' });
    }

    const lines = [
      `Paciente: ${patient.name || report.patientName || '-'}`,
      `CPF: ${patient.cpf || report.cpf || '-'}`,
      `Exame: ${report.exam || report.appointment?.specialty || '-'}`,
      `Data/Hora: ${String(report.appointment?.date || '-')} ${String(report.appointment?.time || '')}`.trim(),
      `Médico solicitante: ${report.requestingDoctor || '-'}`,
      `Médico laudo: ${report.reportingDoctor || '-'}`,
      `Status: ${report.status || '-'}`,
      '---',
      `Descrição: ${report.description || '-'}`,
      `Conclusão: ${report.conclusion || '-'}`,
      `Observações: ${report.notes || '-'}`,
    ];

    const pdf = buildSimplePdfBuffer('Laudo Médico - Saudy', lines);
    const fileName = `laudo-${report.id}.pdf`;
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `attachment; filename="${fileName}"`);
    reply.header('Content-Length', String(pdf.length));
    return reply.send(pdf);
  });

  app.get('/patient-portal/public/reports/:token/pdf', {
    schema: {
      summary: 'Download shared patient report by secure token',
      tags: ['Auth'],
      params: {
        type: 'object',
        properties: { token: { type: 'string' } },
        required: ['token'],
      },
    },
  }, async (request, reply) => {
    const { token } = request.params as { token: string };
    let sharePayload: any = null;

    try {
      sharePayload = app.jwt.verify(String(token || ''));
    } catch {
      return reply.code(401).send({ error: 'Link inválido ou expirado' });
    }

    if (String(sharePayload?.scope || '') !== 'patient_report_share' || !sharePayload?.reportId || !sharePayload?.patientId) {
      return reply.code(401).send({ error: 'Token inválido para compartilhamento de laudo' });
    }

    const patient = await prisma.patient.findFirst({
      where: {
        id: String(sharePayload.patientId),
        ...(sharePayload.branchId ? { branchId: String(sharePayload.branchId) } : {}),
        ...(sharePayload.cpf ? { cpf: String(sharePayload.cpf) } : {}),
        isActive: true,
      },
      select: {
        id: true,
        branchId: true,
        name: true,
        cpf: true,
      },
    });

    if (!patient) {
      return reply.code(404).send({ error: 'Paciente não encontrado para este link' });
    }

    const report = await prisma.report.findFirst({
      where: {
        id: String(sharePayload.reportId),
        isActive: true,
        ...(patient.branchId ? { branchId: patient.branchId } : {}),
        OR: [
          { cpf: patient.cpf },
          { appointment: { is: { patientId: patient.id } } },
          { appointment: { is: { patientCpf: patient.cpf } } },
        ],
      },
      include: {
        appointment: {
          select: {
            date: true,
            time: true,
            specialty: true,
            doctorName: true,
          },
        },
      },
    });

    if (!report) return reply.code(404).send({ error: 'Laudo não encontrado' });
    if (!isVisibleToPatientReport(report.status)) {
      return reply.code(400).send({ error: 'Laudo ainda não liberado para download' });
    }

    const lines = [
      `Paciente: ${patient.name || report.patientName || '-'}`,
      `CPF: ${patient.cpf || report.cpf || '-'}`,
      `Exame: ${report.exam || report.appointment?.specialty || '-'}`,
      `Data/Hora: ${String(report.appointment?.date || '-')} ${String(report.appointment?.time || '')}`.trim(),
      `Médico solicitante: ${report.requestingDoctor || '-'}`,
      `Médico laudo: ${report.reportingDoctor || '-'}`,
      `Status: ${report.status || '-'}`,
      '---',
      `Descrição: ${report.description || '-'}`,
      `Conclusão: ${report.conclusion || '-'}`,
      `Observações: ${report.notes || '-'}`,
    ];

    const pdf = buildSimplePdfBuffer('Laudo Médico - Saudy', lines);
    const fileName = `laudo-${report.id}.pdf`;
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `attachment; filename="${fileName}"`);
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Length', String(pdf.length));
    return reply.send(pdf);
  });

  // ── DICOM helper: find worklist item owned by patient ──────────────────────
  async function getPatientWorklistItem(patient: any, reportId: string) {
    const report = await prisma.report.findFirst({
      where: {
        id: reportId,
        isActive: true,
        ...(patient.branchId ? { branchId: patient.branchId } : {}),
        OR: [
          { cpf: patient.cpf },
          { appointment: { is: { patientId: patient.id } } },
          { appointment: { is: { patientCpf: patient.cpf } } },
        ],
      },
      select: {
        id: true,
        status: true,
        worklistItem: { select: { id: true, dicomStudyUid: true } },
      },
    });
    return report;
  }

  app.get('/patient-portal/me/reports/:reportId/dicom/series', {
    schema: {
      summary: 'List DICOM series for a patient report',
      tags: ['Auth'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { reportId: { type: 'string' } }, required: ['reportId'] },
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;
    const patient = await getPatientFromPayload(payload);
    if (!patient) return reply.code(404).send({ error: 'Paciente não encontrado' });

    const { reportId } = request.params as { reportId: string };
    const report = await getPatientWorklistItem(patient, reportId);
    if (!report) return reply.code(404).send({ error: 'Laudo não encontrado' });
    if (!isVisibleToPatientReport(report.status)) return reply.code(403).send({ error: 'Laudo não disponível' });
    if (!report.worklistItem) return reply.code(404).send({ error: 'Sem imagens DICOM para este laudo' });

    const files = await prisma.dicomFile.findMany({
      where: { worklistItemId: report.worklistItem.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, seriesUid: true, instanceId: true },
    });

    const bySeries = new Map<string, { seriesUid: string | null; instancesCount: number }>();
    for (const f of files) {
      const k = f.seriesUid || '__no_series__';
      if (!bySeries.has(k)) bySeries.set(k, { seriesUid: f.seriesUid, instancesCount: 0 });
      bySeries.get(k)!.instancesCount++;
    }

    return {
      reportId,
      worklistItemId: report.worklistItem.id,
      series: Array.from(bySeries.values()),
      totalInstances: files.length,
    };
  });

  app.get('/patient-portal/me/reports/:reportId/dicom/files', {
    schema: {
      summary: 'List DICOM files for a patient report (optionally filtered by series)',
      tags: ['Auth'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { reportId: { type: 'string' } }, required: ['reportId'] },
      querystring: { type: 'object', properties: { seriesUid: { type: 'string' } } },
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;
    const patient = await getPatientFromPayload(payload);
    if (!patient) return reply.code(404).send({ error: 'Paciente não encontrado' });

    const { reportId } = request.params as { reportId: string };
    const { seriesUid } = request.query as { seriesUid?: string };
    const report = await getPatientWorklistItem(patient, reportId);
    if (!report) return reply.code(404).send({ error: 'Laudo não encontrado' });
    if (!isVisibleToPatientReport(report.status)) return reply.code(403).send({ error: 'Laudo não disponível' });
    if (!report.worklistItem) return reply.code(404).send({ error: 'Sem imagens DICOM para este laudo' });

    const resolvedSeries = seriesUid === '__NO_SERIES__' ? null : (seriesUid ?? undefined);
    const where: any = { worklistItemId: report.worklistItem.id };
    if (resolvedSeries !== undefined) where.seriesUid = resolvedSeries;

    const files = await prisma.dicomFile.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      select: { id: true, seriesUid: true, instanceId: true },
    });

    return {
      files: files.map((f: any) => ({
        id: f.id,
        seriesUid: f.seriesUid,
        instanceId: f.instanceId,
        url: `/auth/patient-portal/me/reports/${reportId}/dicom/images/${f.id}`,
      })),
    };
  });

  app.get('/patient-portal/me/reports/:reportId/dicom/images/:fileId', {
    schema: {
      summary: 'Stream a DICOM image file for a patient report',
      tags: ['Auth'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: { reportId: { type: 'string' }, fileId: { type: 'string' } },
        required: ['reportId', 'fileId'],
      },
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;
    const patient = await getPatientFromPayload(payload);
    if (!patient) return reply.code(404).send({ error: 'Paciente não encontrado' });

    const { reportId, fileId } = request.params as { reportId: string; fileId: string };
    const report = await getPatientWorklistItem(patient, reportId);
    if (!report) return reply.code(404).send({ error: 'Laudo não encontrado' });
    if (!isVisibleToPatientReport(report.status)) return reply.code(403).send({ error: 'Laudo não disponível' });
    if (!report.worklistItem) return reply.code(404).send({ error: 'Sem imagens DICOM' });

    const dicomFile = await prisma.dicomFile.findFirst({
      where: { id: fileId, worklistItemId: report.worklistItem.id },
    });
    if (!dicomFile) return reply.code(404).send({ error: 'Arquivo DICOM não encontrado' });

    const { getDicomStreamFromGcs } = await import('../../../modules/dicom/gcs');
    let stream;
    try {
      stream = getDicomStreamFromGcs((dicomFile as any).path);
    } catch (err: any) {
      return reply.code(404).send({ error: 'Arquivo não encontrado no armazenamento' });
    }
    reply.header('Content-Type', 'application/dicom');
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(stream);
  });

  app.get('/patient-portal/me/delivery-requests', {
    schema: {
      summary: 'List patient physical delivery requests',
      tags: ['Auth'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;

    const patient = await getPatientFromPayload(payload);
    if (!patient) return reply.code(404).send({ error: 'Paciente não encontrado' });

    const { limit = 50, offset = 0 } = request.query as { limit?: number; offset?: number };
    const cpfMarker = `PacienteCPF:${patient.cpf}`;

    const where: any = {
      isActive: true,
      documentType: 'LAUDO_FISICO',
      OR: [
        { description: { contains: cpfMarker, mode: 'insensitive' } },
        { patientName: { equals: patient.name || '', mode: 'insensitive' } },
      ],
    };

    const [items, total] = await Promise.all([
      prisma.delivery.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        take: limit,
        skip: offset,
      }),
      prisma.delivery.count({ where }),
    ]);

    return { items, total };
  });

  app.post('/patient-portal/me/reports/:reportId/request-physical-delivery', {
    schema: {
      summary: 'Request physical report delivery/print on demand',
      tags: ['Auth'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: { reportId: { type: 'string' } },
        required: ['reportId'],
      },
      body: {
        type: 'object',
        properties: {
          preferredDate: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;

    const patient = await getPatientFromPayload(payload);
    if (!patient) return reply.code(404).send({ error: 'Paciente não encontrado' });

    const { reportId } = request.params as { reportId: string };
    const { preferredDate, notes } = (request.body || {}) as { preferredDate?: string; notes?: string };

    const report = await prisma.report.findFirst({
      where: {
        id: reportId,
        isActive: true,
        ...(patient.branchId ? { branchId: patient.branchId } : {}),
        OR: [
          { cpf: patient.cpf },
          { appointment: { is: { patientId: patient.id } } },
          { appointment: { is: { patientCpf: patient.cpf } } },
        ],
      },
      include: {
        appointment: {
          select: {
            date: true,
            time: true,
            specialty: true,
          },
        },
      },
    });

    if (!report) {
      return reply.code(404).send({ error: 'Laudo não encontrado para este paciente' });
    }

    if (!isVisibleToPatientReport(report.status)) {
      return reply.code(400).send({ error: 'Este laudo ainda não está liberado para entrega' });
    }

    const normalizedPreferred = String(preferredDate || '').trim();
    const availableAt = normalizedPreferred ? new Date(`${normalizedPreferred}T09:00:00`) : new Date();
    if (Number.isNaN(availableAt.getTime())) {
      return reply.code(400).send({ error: 'Data preferencial inválida' });
    }

    const delivery = await prisma.delivery.create({
      data: {
        patientName: patient.name || report.patientName || 'Paciente',
        documentType: 'LAUDO_FISICO',
        availableAt,
        status: 'SOLICITADO_IMPRESSAO',
        description: [
          `Solicitação pelo Portal do Paciente.`,
          `PacienteCPF:${patient.cpf}.`,
          `Laudo: ${report.id}.`,
          report.exam ? `Exame: ${report.exam}.` : null,
          report.appointment?.specialty ? `Especialidade: ${report.appointment.specialty}.` : null,
          normalizedPreferred ? `Data preferencial: ${normalizedPreferred}.` : null,
          notes ? `Observações: ${String(notes).trim()}` : null,
        ].filter(Boolean).join(' '),
        responsible: null,
      },
    });

    return reply.code(201).send({
      message: 'Solicitação de entrega física registrada com sucesso',
      request: {
        id: delivery.id,
        status: delivery.status,
        availableAt: delivery.availableAt,
      },
    });
  });

  // ---------------------------------------------------------------------------
  // Self-scheduling endpoints
  // ---------------------------------------------------------------------------

  function parseTimeToMinutes(value?: string | null): number | null {
    const parts = String(value || '').trim().split(':');
    if (parts.length < 2) return null;
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
  }

  function minutesToTimeStr(value: number): string {
    const h = String(Math.floor(value / 60)).padStart(2, '0');
    const m = String(value % 60).padStart(2, '0');
    return `${h}:${m}`;
  }

  function slotRangesOverlap(
    startA?: string | null, durationA?: number | null,
    startB?: string | null, durationB?: number | null,
  ): boolean {
    const a = parseTimeToMinutes(startA);
    const b = parseTimeToMinutes(startB);
    if (a === null || b === null) return false;
    const da = Number.isFinite(durationA) && Number(durationA) > 0 ? Number(durationA) : 30;
    const db = Number.isFinite(durationB) && Number(durationB) > 0 ? Number(durationB) : 30;
    return a < b + db && b < a + da;
  }

  const SELF_SCHED_BLOCKED_STATUSES = new Set([
    'CANCELADO', 'CANCELED', 'NAO_COMPARECEU', 'NÃO_COMPARECEU',
    'NO_SHOW', 'NO-SHOW', 'AUSENTE', 'FALTOU', 'REALIZADO', 'COMPLETED',
    'FINALIZADO', 'ATENDIDO', 'CONCLUIDO',
  ]);

  async function getSelfSchedDoctorConflicts(branchId: string, doctorName: string, date: string) {
    return prisma.appointment.findMany({
      where: {
        branchId,
        doctorName,
        date,
        isActive: true,
        NOT: Array.from(SELF_SCHED_BLOCKED_STATUSES).map((s) => ({ status: s })),
      },
      select: { time: true, durationMinutes: true },
    });
  }

  async function getSelfSchedPatientConflicts(branchId: string, patientId: string, patientCpf: string, date: string) {
    return prisma.appointment.findMany({
      where: {
        branchId,
        date,
        isActive: true,
        OR: [
          { patientId },
          { patientCpf: { contains: normalizeCpf(patientCpf) } },
        ],
        NOT: Array.from(SELF_SCHED_BLOCKED_STATUSES).map((s) => ({ status: s })),
      },
      select: { time: true, durationMinutes: true },
    });
  }

  function generateSlotsForDay(workingHoursStart: string, workingHoursEnd: string, durationMinutes: number): string[] {
    const start = parseTimeToMinutes(workingHoursStart);
    const end = parseTimeToMinutes(workingHoursEnd);
    if (start === null || end === null) return [];
    const slots: string[] = [];
    for (let t = start; t + durationMinutes <= end; t += durationMinutes) {
      slots.push(minutesToTimeStr(t));
    }
    return slots;
  }

  const WEEKDAY_MAP: Record<string, number> = {
    domingo: 0, sunday: 0,
    segunda: 1, monday: 1,
    terca: 2, 'terça': 2, tuesday: 2,
    quarta: 3, wednesday: 3,
    quinta: 4, thursday: 4,
    sexta: 5, friday: 5,
    sabado: 6, 'sábado': 6, saturday: 6,
  };

  function doctorWorksOnDate(doctor: any, dateStr: string): boolean {
    const date = new Date(`${dateStr}T12:00:00Z`);
    const dayOfWeek = date.getUTCDay();

    // Check workingSchedules JSON first (per-schedule overrides)
    try {
      const schedules = JSON.parse(String(doctor.workingSchedules || '[]'));
      if (Array.isArray(schedules) && schedules.length > 0) {
        return schedules.some((sched: any) => {
          const days: string[] = Array.isArray(sched.days) ? sched.days : [];
          return days.some((d: string) => WEEKDAY_MAP[String(d).toLowerCase()] === dayOfWeek);
        });
      }
    } catch {
      // fall through to workingDays
    }

    const workingDays: string[] = Array.isArray(doctor.workingDays) ? doctor.workingDays : [];
    return workingDays.some((d: string) => WEEKDAY_MAP[String(d).toLowerCase()] === dayOfWeek);
  }

  app.get('/patient-portal/scheduling/branches', {
    schema: {
      summary: 'List branches available for self-scheduling',
      tags: ['PatientPortal'],
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;

    const patient = await getPatientFromPayload(payload);
    if (!patient) return reply.code(404).send({ error: 'Paciente não encontrado' });

    // Determine company from the patient's branch (or from any branch associated with this CPF)
    let companyId: string | null = null;
    if (patient.branchId) {
      const branch = await prisma.branch.findUnique({ where: { id: patient.branchId }, select: { companyId: true } });
      companyId = branch?.companyId || null;
    }

    // Fallback: find company via patient CPF across any branch
    if (!companyId) {
      const anyPatient = await prisma.patient.findFirst({
        where: { cpf: patient.cpf, branchId: { not: null } },
        select: { branchId: true },
      });
      if (anyPatient?.branchId) {
        const fallbackBranch = await prisma.branch.findUnique({ where: { id: anyPatient.branchId }, select: { companyId: true } });
        companyId = fallbackBranch?.companyId || null;
      }
    }

    if (!companyId) {
      return { branches: [], defaultBranchId: null };
    }

    // Find branch IDs that have at least one active procedure with a doctor linked
    const proceduresWithDoctors = await prisma.procedure.findMany({
      where: { isActive: true, branchId: { not: null }, doctors: { some: {} } },
      select: { branchId: true },
      distinct: ['branchId'],
    });
    const eligibleBranchIds = proceduresWithDoctors.map((p: any) => p.branchId as string);

    const branches = await prisma.branch.findMany({
      where: { companyId, id: { in: eligibleBranchIds } },
      select: { id: true, tradeName: true, address: true },
      orderBy: { tradeName: 'asc' },
    });

    return {
      branches,
      defaultBranchId: patient.branchId || (branches.length === 1 ? branches[0].id : null),
    };
  });

  app.get('/patient-portal/scheduling/procedures', {
    schema: {
      summary: 'List available procedures for self-scheduling',
      tags: ['PatientPortal'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: { branchId: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;

    const patient = await getPatientFromPayload(payload);
    if (!patient) return reply.code(404).send({ error: 'Paciente não encontrado' });

    const { branchId: selectedBranchId } = request.query as { branchId?: string };
    const branchId = selectedBranchId || patient.branchId;
    if (!branchId) return reply.code(400).send({ error: 'Paciente sem unidade associada' });

    const [procedures, branch] = await Promise.all([
      prisma.procedure.findMany({
        where: { branchId, isActive: true, doctors: { some: {} } },
        select: {
          id: true, name: true, description: true, appointmentType: true,
          durationMinutes: true, acceptsInsurance: true, modalities: true,
        },
        orderBy: { name: 'asc' },
      }),
      prisma.branch.findUnique({ where: { id: branchId }, select: { tradeName: true, address: true } }),
    ]);

    return { procedures, branch: branch ? { name: branch.tradeName, address: branch.address } : null };
  });

  app.get('/patient-portal/scheduling/doctors', {
    schema: {
      summary: 'List doctors available for self-scheduling by procedure',
      tags: ['PatientPortal'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: { procedureId: { type: 'string' }, branchId: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;

    const patient = await getPatientFromPayload(payload);
    if (!patient) return reply.code(404).send({ error: 'Paciente não encontrado' });

    const { procedureId, branchId: selectedBranchId } = request.query as { procedureId?: string; branchId?: string };
    const branchId = selectedBranchId || patient.branchId;
    if (!branchId) return reply.code(400).send({ error: 'Paciente sem unidade associada' });

    const where: any = { branchId, isActive: true };
    if (procedureId) {
      const links = await prisma.procedureDoctor.findMany({
        where: { procedureId },
        select: { doctorId: true },
      });
      const doctorIds = links.map((l: any) => String(l.doctorId));
      if (doctorIds.length === 0) return { doctors: [] };
      where.id = { in: doctorIds };
    }

    const doctors = await prisma.doctor.findMany({
      where,
      select: {
        id: true,
        name: true,
        specialty: true,
        crm: true,
        crmState: true,
        workingDays: true,
        workingHoursStart: true,
        workingHoursEnd: true,
        workingSchedules: true,
      },
      orderBy: { name: 'asc' },
    });

    return {
      doctors: doctors.map((d: any) => ({
        id: d.id,
        name: d.name,
        specialty: d.specialty,
        crm: `${d.crm}-${d.crmState}`,
      })),
    };
  });

  app.get('/patient-portal/scheduling/available-slots', {
    schema: {
      summary: 'Get available scheduling slots for a doctor',
      tags: ['PatientPortal'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          doctorName: { type: 'string' },
          procedureId: { type: 'string' },
          branchId: { type: 'string' },
        },
        required: ['doctorName'],
      },
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;

    const patient = await getPatientFromPayload(payload);
    if (!patient) return reply.code(404).send({ error: 'Paciente não encontrado' });

    const { doctorName, procedureId, branchId: selectedBranchId } = request.query as {
      doctorName: string;
      procedureId?: string;
      branchId?: string;
    };
    const branchId = selectedBranchId || patient.branchId;
    if (!branchId) return reply.code(400).send({ error: 'Paciente sem unidade associada' });

    // Resolve duration from procedure if provided
    let slotDurationFromProcedure = 30;
    if (procedureId) {
      const proc = await prisma.procedure.findFirst({
        where: { id: procedureId, branchId, isActive: true },
        select: { durationMinutes: true },
      });
      if (proc?.durationMinutes) slotDurationFromProcedure = proc.durationMinutes;
    }

    const doctor = await prisma.doctor.findFirst({
      where: { branchId, isActive: true, name: doctorName },
      select: {
        workingDays: true,
        workingHoursStart: true,
        workingHoursEnd: true,
        workingSchedules: true,
      },
    });

    if (!doctor) return reply.code(404).send({ error: 'Profissional não encontrado' });

    const slotDuration = slotDurationFromProcedure;

    const workStart = doctor.workingHoursStart || '08:00';
    const workEnd = doctor.workingHoursEnd || '18:00';

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    type SlotsByDate = { date: string; slots: string[] };
    const result: SlotsByDate[] = [];

    for (let i = 1; i <= 30 && result.length < 14; i++) {
      const d = new Date(today);
      d.setUTCDate(today.getUTCDate() + i);
      const dateStr = d.toISOString().slice(0, 10);

      if (!doctorWorksOnDate(doctor, dateStr)) continue;

      const allSlots = generateSlotsForDay(workStart, workEnd, slotDuration);
      if (allSlots.length === 0) continue;

      const [doctorConflicts, patientConflicts] = await Promise.all([
        getSelfSchedDoctorConflicts(branchId, doctorName, dateStr),
        getSelfSchedPatientConflicts(branchId, patient.id, patient.cpf, dateStr),
      ]);

      const available = allSlots.filter((slot) => {
        const blockedByDoctor = doctorConflicts.some((c: any) =>
          slotRangesOverlap(slot, slotDuration, c.time, c.durationMinutes),
        );
        const blockedByPatient = patientConflicts.some((c: any) =>
          slotRangesOverlap(slot, slotDuration, c.time, c.durationMinutes),
        );
        return !blockedByDoctor && !blockedByPatient;
      });

      if (available.length > 0) {
        result.push({ date: dateStr, slots: available });
      }
    }

    return { availableSlots: result, slotDurationMinutes: slotDuration };
  });

  app.post('/patient-portal/scheduling/appointments', {
    schema: {
      summary: 'Self-schedule an appointment from the patient portal',
      tags: ['PatientPortal'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          procedureId: { type: 'string' },
          doctorName: { type: 'string' },
          date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          time: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
          modalidadeAtendimento: { type: 'string', enum: ['Presencial', 'Teleconsulta'] },
          observations: { type: 'string' },
          branchId: { type: 'string' },
        },
        required: ['procedureId', 'doctorName', 'date', 'time'],
      },
    },
  }, async (request, reply) => {
    const payload = await requirePatientPortalAuth(request, reply);
    if (!payload || (payload as any).error) return;

    const patient = await getPatientFromPayload(payload);
    if (!patient) return reply.code(404).send({ error: 'Paciente não encontrado' });

    const body = request.body as {
      procedureId: string;
      doctorName: string;
      date: string;
      time: string;
      modalidadeAtendimento?: 'Presencial' | 'Teleconsulta';
      observations?: string;
      branchId?: string;
    };

    const branchId = body.branchId || patient.branchId;
    if (!branchId) return reply.code(400).send({ error: 'Paciente sem unidade associada' });

    const procedure = await prisma.procedure.findFirst({
      where: { id: body.procedureId, branchId, isActive: true },
      select: { id: true, name: true, appointmentType: true, durationMinutes: true },
    });
    if (!procedure) return reply.code(404).send({ error: 'Procedimento não encontrado' });

    const normalizedDate = normalizeDateInput(body.date);
    if (!normalizedDate) return reply.code(400).send({ error: 'Data inválida' });

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const appointmentDate = new Date(`${normalizedDate}T00:00:00Z`);
    if (appointmentDate <= today) {
      return reply.code(400).send({ error: 'A data do agendamento deve ser futura' });
    }

    const slotDuration = procedure.durationMinutes || 30;

    // Re-validate slot availability at creation time
    const [doctorConflicts, patientConflicts] = await Promise.all([
      getSelfSchedDoctorConflicts(branchId, body.doctorName, normalizedDate),
      getSelfSchedPatientConflicts(branchId, patient.id, patient.cpf, normalizedDate),
    ]);

    const doctorBlocked = doctorConflicts.some((c: any) =>
      slotRangesOverlap(body.time, slotDuration, c.time, c.durationMinutes),
    );
    if (doctorBlocked) {
      return reply.code(409).send({
        error: 'Scheduling conflict',
        conflictType: 'DOCTOR',
        message: 'O profissional já possui outro agendamento nesse horário. Por favor, escolha outro horário.',
      });
    }

    const patientBlocked = patientConflicts.some((c: any) =>
      slotRangesOverlap(body.time, slotDuration, c.time, c.durationMinutes),
    );
    if (patientBlocked) {
      return reply.code(409).send({
        error: 'Scheduling conflict',
        conflictType: 'PATIENT',
        message: 'Você já possui outro agendamento nesse horário. Por favor, escolha outro horário.',
      });
    }

    const convenio = (patient as any).hasHealthInsurance ? ((patient as any).healthInsuranceName || null) : null;

    // Build observations: prepend teleconsultation marker if needed (same pattern used by main scheduling module)
    const TELE_MARKER = '[MODALIDADE: TELECONSULTA]';
    let observations: string | null = null;
    if (body.modalidadeAtendimento === 'Teleconsulta') {
      observations = body.observations ? `${TELE_MARKER}\n${body.observations}` : TELE_MARKER;
    } else {
      observations = body.observations || null;
    }

    const branch = await prisma.branch.findUnique({ where: { id: branchId }, select: { tradeName: true, address: true } });

    const created = await prisma.appointment.create({
      data: {
        branchId,
        patientId: patient.id,
        patientName: patient.name,
        patientCpf: patient.cpf,
        doctorName: body.doctorName,
        specialty: procedure.name,
        sourceProcedureId: procedure.id,
        date: normalizedDate,
        time: body.time,
        durationMinutes: slotDuration,
        type: procedure.appointmentType || 'CONSULTA',
        status: 'CONFIRMADO',
        convenio,
        observations,
        authorizationStatus: 'PENDING',
        accessionNumber: `PP-${Date.now()}`,
      },
    });

    // Send WhatsApp notification
    try {
      const { publishAppointmentCreatedEvent } = await import('../../care/lib/appointment-whatsapp-events');
      publishAppointmentCreatedEvent({ branchId, appointmentId: created.id });
    } catch (err) {
      request.log.warn({ err }, 'Failed to publish WhatsApp appointment event');
    }

    return reply.code(201).send({
      id: created.id,
      date: created.date,
      time: created.time,
      specialty: created.specialty,
      doctorName: created.doctorName,
      status: created.status,
      type: created.type,
      durationMinutes: created.durationMinutes,
      createdAt: created.createdAt,
      branchName: branch?.tradeName || null,
      branchAddress: branch?.address || null,
    });
  });
}
