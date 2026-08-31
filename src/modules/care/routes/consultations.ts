import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

const normalizeStatusKey = (value?: string | null) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toUpperCase();

const canonicalClinicalQueueStatus = (value?: string | null) => {
  const key = normalizeStatusKey(value);
  if (!key) return '';
  return key.replace(/\s+/g, '_');
};

const CLINICAL_QUEUE_TRANSITION_RULES: Record<string, string[]> = {
  AGUARDANDO_ATENDIMENTO: ['CHAMADO_PARA_ATENDIMENTO', 'CANCELADO', 'CANCELADA'],
  AGUARDANDO_TRIAGEM: ['EM_TRIAGEM', 'CANCELADO', 'CANCELADA'],
  EM_TRIAGEM: ['AGUARDANDO_EXAME', 'CANCELADO', 'CANCELADA'],
  AGUARDANDO_EXAME: ['CHAMADO_PARA_EXAME', 'CANCELADO', 'CANCELADA'],
  CHAMADO_PARA_EXAME: ['EM_EXAME', 'CANCELADO', 'CANCELADA'],
  EM_EXAME: ['EXAME_CONCLUIDO', 'CANCELADO', 'CANCELADA'],
  EXAME_CONCLUIDO: [],
  CHAMADO_PARA_ATENDIMENTO: ['EM_ATENDIMENTO', 'CANCELADO', 'CANCELADA'],
  EM_ATENDIMENTO: ['ATENDIMENTO_CONCLUIDO', 'CANCELADO', 'CANCELADA'],
  ATENDIMENTO_CONCLUIDO: [],
  CANCELADO: [],
  CANCELADA: [],
};

const canTransitionClinicalQueue = (fromRaw?: string | null, toRaw?: string | null) => {
  const from = canonicalClinicalQueueStatus(fromRaw);
  const to = canonicalClinicalQueueStatus(toRaw);
  if (!to || from === to) return true;
  if (!from) return true;
  const allowed = CLINICAL_QUEUE_TRANSITION_RULES[from];
  if (!Array.isArray(allowed)) return true;
  return allowed.includes(to);
};

const appendQueueStatusAudit = (
  previousTriageNotes: string | null | undefined,
  fromStatus?: string | null,
  toStatus?: string | null,
  userId?: string | null,
) => {
  const from = String(fromStatus || '').trim() || 'SEM_STATUS';
  const to = String(toStatus || '').trim() || 'SEM_STATUS';
  if (from === to) return previousTriageNotes || null;

  const timestamp = new Date().toISOString();
  const actor = userId ? `user:${userId}` : 'user:unknown';
  const line = `[queue-transition] ${timestamp} ${actor} "${from}" -> "${to}"`;
  return [String(previousTriageNotes || '').trim(), line].filter(Boolean).join('\n');
};

const CONFIRMED_APPOINTMENT_STATUSES = new Set(['CONFIRMADO', 'CONFIRMED', 'AGENDADO', 'SCHEDULED']);
const CLINIC_TIME_ZONE = process.env.APP_TIMEZONE || 'America/Sao_Paulo';
const TELECONSULTATION_OBSERVATION_MARKER = '[MODALIDADE: TELECONSULTA]';
const DIGITS_ONLY_REGEX = /\D/g;
const QUESTION_TYPES = new Set([
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'DATE',
  'TIME',
  'DATETIME',
  'BOOLEAN',
  'SINGLE_CHOICE',
  'MULTIPLE_CHOICE',
]);
const APPOINTMENT_TERMINAL_STATUS_KEYS = new Set([
  'REALIZADO',
  'FINALIZADO',
  'COMPLETED',
  'ATENDIDO',
  'CANCELADO',
  'CANCELED',
  'NAO_COMPARECEU',
  'NO_SHOW',
  'NO-SHOW',
  'AUSENTE',
  'FALTOU',
]);
const APPOINTMENT_NO_SHOW_UPDATABLE_STATUS_KEYS = new Set(['AGENDADO', 'CONFIRMADO']);
const FINAL_REPORT_STATUSES = new Set([
  'FINALIZADO',
  'FINALIZADO_COM_REVISAO',
  'LIBERADO',
  'ASSINADO',
  'CONCLUIDO',
  'FINAL',
  'APROVADO',
]);

const normalizeAppointmentStatusKey = (value?: string | null) => normalizeStatusKey(value).replace(/\s+/g, '_');

const isTerminalAppointmentStatus = (value?: string | null) => {
  const normalized = normalizeAppointmentStatusKey(value);
  return APPOINTMENT_TERMINAL_STATUS_KEYS.has(normalized);
};

const isTerminalClinicalQueueStatus = (value?: string | null) => {
  const normalized = canonicalClinicalQueueStatus(value);
  return normalized === 'ATENDIMENTO_CONCLUIDO'
    || normalized === 'EXAME_CONCLUIDO'
    || normalized === 'CANCELADO'
    || normalized === 'CANCELADA'
    || normalized === 'NAO_COMPARECEU';
};

const getTimeZoneParts = (date: Date, timeZone = CLINIC_TIME_ZONE) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const readPart = (type: string) => parts.find((item) => item.type === type)?.value || '';

  return {
    year: readPart('year'),
    month: readPart('month'),
    day: readPart('day'),
    hour: readPart('hour'),
    minute: readPart('minute'),
  };
};

const getTodayDateString = () => {
  const { year, month, day } = getTimeZoneParts(new Date());
  return `${year}-${month}-${day}`;
};

const getNowTimeString = () => {
  const { hour, minute } = getTimeZoneParts(new Date());
  return `${hour}:${minute}`;
};

const applyAutomaticNoShowForBranchInConsultationQueue = async (branchId: string) => {
  const settings = await prisma.branchSettings.findUnique({ where: { branchId } });
  const toleranceMinutes = Math.max(0, Number(settings?.noShowToleranceMinutes ?? 30));
  const threshold = new Date(Date.now() - (toleranceMinutes * 60 * 1000));
  const { year, month, day, hour, minute } = getTimeZoneParts(threshold);
  const thresholdDate = `${year}-${month}-${day}`;
  const thresholdTime = `${hour}:${minute}`;

  const candidates = await prisma.appointment.findMany({
    where: {
      branchId,
      isActive: true,
      status: { in: Array.from(APPOINTMENT_NO_SHOW_UPDATABLE_STATUS_KEYS) },
      OR: [
        { date: { lt: thresholdDate } },
        {
          AND: [
            { date: thresholdDate },
            { time: { lte: thresholdTime } },
          ],
        },
      ],
    },
    select: { id: true },
    take: 500,
  });

  if (!candidates.length) return;
  const appointmentIds = candidates.map((item: any) => String(item.id));

  await prisma.$transaction(async (tx: any) => {
    await tx.appointment.updateMany({
      where: { id: { in: appointmentIds } },
      data: { status: 'NAO_COMPARECEU' },
    });

    await tx.mwlEntry.updateMany({
      where: { appointmentId: { in: appointmentIds } },
      data: { status: 'cancelado', isActive: false },
    });
  });
};

const parseAgendaSummary = (value?: string | null) => {
  const raw = String(value || '').trim();
  if (!raw) return { time: '', specialty: '', doctorName: '' };
  const firstSlot = raw.split('|')[0]?.trim() || raw;
  const parts = firstSlot.split('•').map((part) => part.trim()).filter(Boolean);
  return {
    time: parts[0] || '',
    specialty: parts[1] || '',
    doctorName: parts[2] || '',
  };
};

const normalizePatientName = (value?: string | null) => String(value || '').trim().toLowerCase();
const normalizeAppointmentType = (value?: string | null) => String(value || '').trim().toUpperCase();

const isExamAppointment = (value?: string | null) => {
  const normalized = normalizeAppointmentType(value);
  return normalized === 'EXAME' || normalized === 'EXAM';
};

const NON_BLOCKING_APPOINTMENT_STATUSES = new Set([
  'CANCELADO',
  'CANCELED',
  'REALIZADO',
  'COMPLETED',
  'FINALIZADO',
  'NO_SHOW',
  'NAO_COMPARECEU',
  'NÃO_COMPARECEU',
  'AUSENTE',
  'FALTOU',
]);

const parseTimeToMinutes = (value?: string | null) => {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{2}):(\d{2})$/);
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

const formatDateToIso = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const normalizeReportStatusKey = (value?: string | null) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toUpperCase()
  .replace(/\s+/g, '_');

const isFinalizedReportStatus = (value?: string | null) => FINAL_REPORT_STATUSES.has(normalizeReportStatusKey(value));

const isTeleconsultationAppointment = (appointment: any) => String(appointment?.observations || '')
  .toUpperCase()
  .includes(TELECONSULTATION_OBSERVATION_MARKER);

const normalizeNursingAnswers = (answers: unknown) => {
  if (!Array.isArray(answers)) return [];

  return answers
    .map((answer: any, index: number) => {
      const questionLabel = String(answer?.questionLabel || '').trim();
      const responseType = String(answer?.responseType || 'TEXT').trim().toUpperCase();
      if (!questionLabel || !QUESTION_TYPES.has(responseType)) return null;

      const answerValues = Array.isArray(answer?.answerValues)
        ? answer.answerValues.map((value: any) => String(value).trim()).filter(Boolean)
        : [];

      return {
        questionId: answer?.questionId ? String(answer.questionId) : null,
        questionLabel,
        responseType,
        answerText: answer?.answerText !== undefined && answer?.answerText !== null ? String(answer.answerText) : null,
        answerValues,
        answerBoolean: typeof answer?.answerBoolean === 'boolean' ? answer.answerBoolean : null,
        answerNumber: Number.isFinite(Number(answer?.answerNumber)) ? Number(answer.answerNumber) : null,
        orderIndex: Number.isFinite(Number(answer?.orderIndex)) ? Number(answer.orderIndex) : index,
      };
    })
    .filter(Boolean);
};

const sortTemplate = (item: any) => ({
  ...item,
  questions: (item?.questions || [])
    .slice()
    .sort((a: any, b: any) => Number(a.orderIndex || 0) - Number(b.orderIndex || 0))
    .map((question: any) => ({
      ...question,
      options: (question?.options || [])
        .slice()
        .sort((a: any, b: any) => Number(a.orderIndex || 0) - Number(b.orderIndex || 0)),
    })),
});

const resolveNursingTemplateForAppointment = async (branchId: string, appointment: any) => {
  if (!appointment || !isExamAppointment(appointment?.type)) return null;

  const specialty = String(appointment?.specialty || '').trim();
  if (!specialty) return null;

  const normalizedSpecialty = specialty
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const procedures = await prisma.procedure.findMany({
    where: {
      branchId,
      isActive: true,
      OR: [
        { name: { equals: specialty, mode: 'insensitive' } },
        { name: { contains: specialty, mode: 'insensitive' } },
      ],
    },
    include: {
      nursingTemplates: {
        where: { isActive: true },
        include: {
          questions: { include: { options: true } },
        },
      },
    },
  });

  const matchedProcedure = procedures.find((procedure: any) => {
    const normalizedProcedureName = String(procedure?.name || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    return normalizedProcedureName === normalizedSpecialty
      || normalizedProcedureName.includes(normalizedSpecialty)
      || normalizedSpecialty.includes(normalizedProcedureName);
  }) || procedures[0];

  const template = matchedProcedure?.nursingTemplates?.[0];
  return template ? sortTemplate(template) : null;
};

const resolveConsultationExamInsights = async (branchId: string, consultations: any[]) => {
  const reportByPatientKey = new Map<string, any[]>();
  const patientIds = new Set<string>();
  const patientCpfs = new Set<string>();
  const patientNames = new Set<string>();

  for (const consultation of consultations) {
    const appointment = consultation?.appointment || null;
    const patientId = String(appointment?.patientId || '').trim();
    const patientCpf = String(appointment?.patientCpf || '').replace(DIGITS_ONLY_REGEX, '').trim();
    const patientName = String(appointment?.patientName || consultation?.patientName || '').trim().toLowerCase();
    if (patientId) patientIds.add(patientId);
    if (patientCpf) patientCpfs.add(patientCpf);
    if (patientName) patientNames.add(patientName);
  }

  if (patientIds.size === 0 && patientCpfs.size === 0 && patientNames.size === 0) {
    return reportByPatientKey;
  }

  const reports = await prisma.report.findMany({
    where: {
      branchId,
      isActive: true,
      OR: [
        ...(patientIds.size > 0 ? [{ appointment: { is: { patientId: { in: Array.from(patientIds) } } } }] : []),
        ...(patientCpfs.size > 0 ? [
          { cpf: { in: Array.from(patientCpfs) } },
          { appointment: { is: { patientCpf: { in: Array.from(patientCpfs) } } } },
        ] : []),
        ...(patientNames.size > 0
          ? Array.from(patientNames).map((name) => ({ patientName: { equals: name, mode: 'insensitive' as const } }))
          : []),
      ],
    },
    select: {
      id: true,
      status: true,
      exam: true,
      updatedAt: true,
      appointmentId: true,
      patientName: true,
      cpf: true,
      appointment: {
        select: {
          patientId: true,
          patientCpf: true,
          patientName: true,
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
    orderBy: { updatedAt: 'desc' },
    take: 500,
  });

  for (const report of reports) {
    const keys = new Set<string>();
    const appointmentPatientId = String(report?.appointment?.patientId || '').trim();
    const appointmentPatientCpf = String(report?.appointment?.patientCpf || '').replace(DIGITS_ONLY_REGEX, '').trim();
    const reportCpf = String(report?.cpf || '').replace(DIGITS_ONLY_REGEX, '').trim();
    const appointmentPatientName = String(report?.appointment?.patientName || '').trim().toLowerCase();
    const reportPatientName = String(report?.patientName || '').trim().toLowerCase();
    if (appointmentPatientId) keys.add(`id:${appointmentPatientId}`);
    if (appointmentPatientCpf) keys.add(`cpf:${appointmentPatientCpf}`);
    if (reportCpf) keys.add(`cpf:${reportCpf}`);
    if (appointmentPatientName) keys.add(`name:${appointmentPatientName}`);
    if (reportPatientName) keys.add(`name:${reportPatientName}`);

    for (const key of keys) {
      const existing = reportByPatientKey.get(key) || [];
      existing.push(report);
      reportByPatientKey.set(key, existing);
    }
  }

  return reportByPatientKey;
};

const resolveConsultationDicomInsights = async (branchId: string, consultations: any[]) => {
  const appointmentIds = Array.from(new Set(
    consultations
      .map((item: any) => String(item?.appointment?.id || item?.appointmentId || '').trim())
      .filter(Boolean),
  ));
  const mapByAppointmentId = new Map<string, any>();
  if (appointmentIds.length === 0) return mapByAppointmentId;

  const items = await prisma.reportWorklistItem.findMany({
    where: {
      appointmentId: { in: appointmentIds },
      OR: [{ branchId }, { branchId: null }],
      isActive: true,
    },
    select: {
      id: true,
      appointmentId: true,
      dicomStudyUid: true,
      dicomUrl: true,
      dicomReceivedAt: true,
      createdAt: true,
      dicomFiles: { select: { id: true }, take: 1 },
    },
    orderBy: [
      { dicomReceivedAt: 'desc' },
      { createdAt: 'desc' },
    ],
    take: 1000,
  });

  for (const worklist of items) {
    const appointmentId = String(worklist?.appointmentId || '').trim();
    if (!appointmentId || mapByAppointmentId.has(appointmentId)) continue;
    const hasImage = Boolean(
      worklist?.dicomReceivedAt
      || worklist?.dicomStudyUid
      || worklist?.dicomUrl
      || (Array.isArray(worklist?.dicomFiles) && worklist.dicomFiles.length > 0),
    );
    mapByAppointmentId.set(appointmentId, {
      hasImage,
      worklist,
    });
  }

  return mapByAppointmentId;
};

const toConsultationView = (item: any) => ({
  ...item,
  appointmentType: item?.appointment?.type || null,
  isTeleconsultation: isTeleconsultationAppointment(item?.appointment),
  triageRequired: Boolean(item?.nursingTemplate),
  nursingTemplate: item?.nursingTemplate || null,
  nursingResponse: item?.nursingResponse
    ? {
        ...item.nursingResponse,
        answers: (item.nursingResponse.answers || [])
          .slice()
          .sort((a: any, b: any) => Number(a.orderIndex || 0) - Number(b.orderIndex || 0)),
      }
    : null,
});

const findTodayAppointmentCandidate = async (params: {
  branchId: string;
  patientName?: string | null;
  doctorName?: string | null;
  agenda?: string | null;
}) => {
  const patientName = normalizePatientName(params.patientName);
  if (!patientName) return null;

  const parsedAgenda = parseAgendaSummary(params.agenda);
  const normalizedDoctor = String(params.doctorName || parsedAgenda.doctorName || '').trim();
  const normalizedSpecialty = String(parsedAgenda.specialty || '').trim();
  const normalizedTime = String(parsedAgenda.time || '').trim();

  const where: any = {
    branchId: params.branchId,
    isActive: true,
    patientName: {
      equals: params.patientName || '',
      mode: 'insensitive',
    },
    date: getTodayDateString(),
  };

  const and: any[] = [];
  if (normalizedDoctor) {
    and.push({ doctorName: { equals: normalizedDoctor, mode: 'insensitive' } });
  }
  if (normalizedSpecialty) {
    and.push({ specialty: { equals: normalizedSpecialty, mode: 'insensitive' } });
  }
  if (normalizedTime) {
    and.push({ time: normalizedTime });
  }
  if (and.length > 0) where.AND = and;

  const candidates = await prisma.appointment.findMany({
    where,
    orderBy: [
      { date: 'asc' },
      { time: 'asc' },
      { createdAt: 'asc' },
    ],
    take: 10,
  });

  return candidates.find((item: any) =>
    CONFIRMED_APPOINTMENT_STATUSES.has(normalizeStatusKey(item?.status || ''))
    || normalizeStatusKey(item?.status || '') === 'EM_ATENDIMENTO',
  ) || candidates[0] || null;
};

const normalizeForMatch = (value?: string | null) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

const generateInvoiceNumber = () => {
  const y = new Date().getFullYear();
  const ts = Date.now().toString().slice(-6);
  const rnd = Math.floor(Math.random() * 900 + 100);
  return `FAT-${y}-${ts}-${rnd}`;
};

const onlyDigits = (value?: string | null) => String(value || '').replace(/\D/g, '');
const formatIsoDate = (value?: Date | null) => {
  if (!value || Number.isNaN(value.getTime())) return null;
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const extractCidCode = (value?: string | null) => {
  const raw = String(value || '').toUpperCase();
  const match = raw.match(/\b([A-Z][0-9]{2}(?:\.[0-9A-Z]{1,2})?)\b/);
  return match?.[1] || null;
};

const sanitizeClinicalIndicationText = (value?: string | null) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.includes('[queue-transition]')) return '';
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.slice(0, 800);
};

const resolveBeneficiarySnapshot = async (params: {
  branchId: string;
  consultation: any;
  appointment: any | null;
}) => {
  const { branchId, consultation, appointment } = params;
  const patientId = String(appointment?.patientId || '').trim();
  const patientCpf = onlyDigits(appointment?.patientCpf || consultation?.cpf || null);
  const appointmentPlan = String(appointment?.convenio || consultation?.convenio || '').trim();

  let patient: any = null;
  if (patientId) {
    patient = await prisma.patient.findFirst({
      where: { id: patientId, branchId },
    });
  }
  if (!patient && patientCpf) {
    patient = await prisma.patient.findFirst({
      where: { cpf: patientCpf, branchId },
    });
  }

  const plan = String(patient?.healthInsuranceName || appointmentPlan || '').trim() || null;
  const cardNumber = String(patient?.healthInsuranceNumber || '').trim() || null;
  const expiry = formatIsoDate(patient?.healthInsuranceExpiry || null);

  const now = new Date();
  const isExpired = Boolean(patient?.healthInsuranceExpiry && patient.healthInsuranceExpiry < now);
  const status = !plan ? 'PARTICULAR' : (isExpired ? 'VENCIDO' : 'ATIVO');

  const hasGuardian = Boolean(patient?.hasGuardian && String(patient?.guardianName || '').trim());
  const holderName = hasGuardian
    ? String(patient?.guardianName || '').trim() || null
    : (String(patient?.name || appointment?.patientName || consultation?.patientName || '').trim() || null);
  const holderDocument = hasGuardian
    ? (onlyDigits(patient?.guardianCpf || null) || null)
    : (onlyDigits(patient?.cpf || appointment?.patientCpf || null) || null);

  const dependentName = hasGuardian ? (String(patient?.name || '').trim() || null) : null;
  const dependentRelationship = hasGuardian
    ? (String(patient?.guardianRelationship || 'DEPENDENTE').trim() || 'DEPENDENTE')
    : null;

  return {
    beneficiaryCardNumber: cardNumber,
    beneficiaryPlan: plan,
    beneficiaryCardExpiry: expiry,
    beneficiaryStatus: status,
    holderName,
    holderDocument,
    dependentName,
    dependentRelationship,
  };
};

const resolveClinicalGuideSnapshot = async (params: {
  branchId: string;
  consultation: any;
  appointment: any | null;
  isExam: boolean;
}) => {
  const { branchId, consultation, appointment, isExam } = params;
  const guideType = isExam ? 'SP_SADT' : 'CONSULTA';
  const clinicalCandidates = [
    consultation?.mainComplaint,
    consultation?.anamnese,
    consultation?.triageNotes,
    appointment?.observations,
  ];
  const indication = clinicalCandidates
    .map((item) => sanitizeClinicalIndicationText(item))
    .find((item) => Boolean(item)) || null;
  const cidCode = extractCidCode(indication);

  const doctorId = String(consultation?.doctorId || '').trim();
  const doctorName = String(consultation?.doctorName || appointment?.doctorName || '').trim();

  let doctor: any = null;
  if (doctorId) {
    doctor = await prisma.doctor.findFirst({
      where: { id: doctorId, branchId },
      select: {
        name: true,
        cpf: true,
        crm: true,
        crmState: true,
      },
    });
  }
  if (!doctor && doctorName) {
    doctor = await prisma.doctor.findFirst({
      where: {
        branchId,
        name: { equals: doctorName, mode: 'insensitive' },
      },
      select: {
        name: true,
        cpf: true,
        crm: true,
        crmState: true,
      },
    });
  }

  const professionalName = String(doctor?.name || doctorName || '').trim() || null;
  const professionalCpf = onlyDigits(doctor?.cpf || null) || null;
  const councilNumber = String(doctor?.crm || '').trim() || null;
  const councilUf = String(doctor?.crmState || '').trim() || null;
  const council = councilNumber ? 'CRM' : null;

  return {
    guideType,
    cidCode,
    clinicalIndication: indication,
    requestingProfessionalName: professionalName,
    requestingProfessionalCpf: professionalCpf,
    requestingProfessionalCouncil: council,
    requestingProfessionalCouncilUf: councilUf,
    requestingProfessionalCouncilNumber: councilNumber,
    requestingProfessionalCbo: null,
    executingProfessionalName: professionalName,
    executingProfessionalCpf: professionalCpf,
    executingProfessionalCouncil: council,
    executingProfessionalCouncilUf: councilUf,
    executingProfessionalCouncilNumber: councilNumber,
    executingProfessionalCbo: null,
  };
};

const resolveAuthorizationSnapshot = async (params: {
  appointment: any | null;
  clinicalGuideType: string;
}) => {
  const { appointment, clinicalGuideType } = params;
  const appointmentId = String(appointment?.id || '').trim();

  let preSchedulingFlow: any = null;
  if (appointmentId) {
    preSchedulingFlow = await prisma.preSchedulingFlow.findUnique({
      where: { appointmentId },
      select: { guideNumber: true },
    });
  }

  const operatorGuideNumber = String(preSchedulingFlow?.guideNumber || '').trim() || null;
  const authorizationDate = appointment?.authorizedAt ? new Date(appointment.authorizedAt) : null;
  const authorizedAttendanceType = String(clinicalGuideType || '').trim() || null;

  return {
    operatorGuideNumber,
    authorizationPassword: null,
    authorizationDate: authorizationDate && !Number.isNaN(authorizationDate.getTime()) ? authorizationDate : null,
    authorizationExpiryDate: null,
    authorizedAttendanceType,
  };
};

const resolveBillingItem = async (params: {
  branchId: string;
  consultation: any;
  appointment: any | null;
  isExam: boolean;
}) => {
  const { branchId, consultation, appointment, isExam } = params;
  const specialty = String(appointment?.specialty || consultation?.agenda || '').trim();
  const executionDateRaw = String(appointment?.date || '').trim();
  const executionTimeRaw = String(appointment?.time || '').trim();
  const executedAt = (() => {
    if (!executionDateRaw) return new Date();
    const normalizedDate = /^\d{4}-\d{2}-\d{2}$/.test(executionDateRaw) ? executionDateRaw : null;
    if (!normalizedDate) return new Date();
    const normalizedTime = /^\d{2}:\d{2}/.test(executionTimeRaw) ? executionTimeRaw.slice(0, 5) : '00:00';
    const parsed = new Date(`${normalizedDate}T${normalizedTime}:00`);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  })();

  if (isExam) {
    const procedures = await prisma.procedure.findMany({
      where: {
        branchId,
        isActive: true,
        appointmentType: { in: ['EXAME', 'EXAM'] },
      },
      select: { id: true, name: true, price: true },
      take: 200,
    });

    const target = normalizeForMatch(specialty);
    const exact = procedures.find((item: any) => normalizeForMatch(item.name) === target);
    const contains = exact ? null : procedures.find((item: any) => {
      const name = normalizeForMatch(item.name);
      return name.includes(target) || target.includes(name);
    });
    const picked = exact || contains || procedures[0];
    const unitValue = Number(picked?.price || 0);
    return {
      procedureId: picked?.id || null,
      procedureName: String(picked?.name || specialty || 'EXAME').trim(),
      tussCode: null,
      tableCode: '22',
      quantity: 1,
      executedAt,
      unitValue,
      totalValue: unitValue,
    };
  }

  const consultationProcedures = await prisma.procedure.findMany({
    where: {
      branchId,
      isActive: true,
      appointmentType: { in: ['CONSULTA', 'CONSULTATION'] },
    },
    select: { id: true, name: true, price: true },
    take: 200,
  });

  const consultationTarget = normalizeForMatch(specialty);
  const consultationExact = consultationProcedures.find((item: any) => normalizeForMatch(item.name) === consultationTarget);
  const consultationContains = consultationExact ? null : consultationProcedures.find((item: any) => {
    const name = normalizeForMatch(item.name);
    return name.includes(consultationTarget) || consultationTarget.includes(name);
  });
  const consultationPicked = consultationExact || consultationContains || consultationProcedures[0];

  if (consultationPicked) {
    const unitValue = Number(consultationPicked?.price || 0);
    return {
      procedureId: consultationPicked.id,
      procedureName: String(consultationPicked.name || specialty || 'CONSULTA').trim(),
      tussCode: null,
      tableCode: '22',
      quantity: 1,
      executedAt,
      unitValue,
      totalValue: unitValue,
    };
  }

  const doctorId = String(consultation?.doctorId || '').trim();
  const doctorName = String(consultation?.doctorName || appointment?.doctorName || '').trim();

  if (doctorId) {
    const doctor = await prisma.doctor.findFirst({
      where: { id: doctorId, branchId },
      select: { consultationFee: true },
    });
    if (doctor?.consultationFee !== null && doctor?.consultationFee !== undefined) {
      const unitValue = Number(doctor.consultationFee || 0);
      return {
        procedureId: null,
        procedureName: 'CONSULTA',
        tussCode: null,
        tableCode: '22',
        quantity: 1,
        executedAt,
        unitValue,
        totalValue: unitValue,
      };
    }
  }

  if (doctorName) {
    const doctor = await prisma.doctor.findFirst({
      where: {
        branchId,
        name: { equals: doctorName, mode: 'insensitive' },
      },
      select: { consultationFee: true },
    });
    if (doctor?.consultationFee !== null && doctor?.consultationFee !== undefined) {
      const unitValue = Number(doctor.consultationFee || 0);
      return {
        procedureId: null,
        procedureName: 'CONSULTA',
        tussCode: null,
        tableCode: '22',
        quantity: 1,
        executedAt,
        unitValue,
        totalValue: unitValue,
      };
    }
  }

  return {
    procedureId: null,
    procedureName: isExam ? 'EXAME' : 'CONSULTA',
    tussCode: null,
    tableCode: '22',
    quantity: 1,
    executedAt,
    unitValue: 0,
    totalValue: 0,
  };
};

const ensureInvoiceForCompletedAppointment = async (params: {
  branchId: string;
  consultation: any;
  appointment: any | null;
  isExam: boolean;
}) => {
  const { branchId, consultation, appointment, isExam } = params;
  const appointmentId = String(appointment?.id || '').trim();
  const consultationId = String(consultation?.id || '').trim();
  if (!appointmentId && !consultationId) return null;

  const existing = appointmentId
    ? await prisma.invoice.findUnique({ where: { sourceAppointmentId: appointmentId } })
    : await prisma.invoice.findUnique({ where: { sourceConsultationId: consultationId } });
  if (existing) return existing;

  const billingItem = await resolveBillingItem({ branchId, consultation, appointment, isExam });
  const beneficiary = await resolveBeneficiarySnapshot({ branchId, consultation, appointment });
  const clinical = await resolveClinicalGuideSnapshot({ branchId, consultation, appointment, isExam });
  const authorization = await resolveAuthorizationSnapshot({ appointment, clinicalGuideType: clinical.guideType });
  const normalizedUnitValue = Number.isFinite(Number(billingItem.unitValue)) ? Number(billingItem.unitValue) : 0;
  const normalizedTotalValue = Number.isFinite(Number(billingItem.totalValue)) ? Number(billingItem.totalValue) : 0;
  const patientName = String(appointment?.patientName || consultation?.patientName || '').trim() || null;
  const convention = String(appointment?.convenio || consultation?.convenio || '').trim() || null;
  const discount = 0;
  const total = normalizedTotalValue - discount;

  let attempts = 0;
  const maxAttempts = 5;
  let created: any = null;
  let numberToUse: string | undefined = undefined;

  while (!created && attempts < maxAttempts) {
    attempts += 1;
    numberToUse = numberToUse || generateInvoiceNumber();
    try {
      created = await prisma.invoice.create({
        data: {
          sourceAppointmentId: appointmentId || null,
          sourceConsultationId: consultationId || null,
          number: numberToUse,
          patientName,
          status: 'EMITIDA',
          convention,
          value: normalizedUnitValue,
          discount,
          total,
          beneficiaryCardNumber: beneficiary.beneficiaryCardNumber,
          beneficiaryPlan: beneficiary.beneficiaryPlan,
          beneficiaryCardExpiry: beneficiary.beneficiaryCardExpiry,
          beneficiaryStatus: beneficiary.beneficiaryStatus,
          holderName: beneficiary.holderName,
          holderDocument: beneficiary.holderDocument,
          dependentName: beneficiary.dependentName,
          dependentRelationship: beneficiary.dependentRelationship,
          guideType: clinical.guideType,
          operatorGuideNumber: authorization.operatorGuideNumber,
          authorizationPassword: authorization.authorizationPassword,
          authorizationDate: authorization.authorizationDate,
          authorizationExpiryDate: authorization.authorizationExpiryDate,
          authorizedAttendanceType: authorization.authorizedAttendanceType,
          cidCode: clinical.cidCode,
          clinicalIndication: clinical.clinicalIndication,
          requestingProfessionalName: clinical.requestingProfessionalName,
          requestingProfessionalCpf: clinical.requestingProfessionalCpf,
          requestingProfessionalCouncil: clinical.requestingProfessionalCouncil,
          requestingProfessionalCouncilUf: clinical.requestingProfessionalCouncilUf,
          requestingProfessionalCouncilNumber: clinical.requestingProfessionalCouncilNumber,
          requestingProfessionalCbo: clinical.requestingProfessionalCbo,
          executingProfessionalName: clinical.executingProfessionalName,
          executingProfessionalCpf: clinical.executingProfessionalCpf,
          executingProfessionalCouncil: clinical.executingProfessionalCouncil,
          executingProfessionalCouncilUf: clinical.executingProfessionalCouncilUf,
          executingProfessionalCouncilNumber: clinical.executingProfessionalCouncilNumber,
          executingProfessionalCbo: clinical.executingProfessionalCbo,
          procedureItems: {
            create: [
              {
                procedureId: billingItem.procedureId,
                procedureName: billingItem.procedureName,
                tussCode: billingItem.tussCode,
                tableCode: billingItem.tableCode,
                quantity: Number.isFinite(Number(billingItem.quantity)) ? Number(billingItem.quantity) : 1,
                executedAt: billingItem.executedAt || new Date(),
                unitValue: normalizedUnitValue,
                totalValue: normalizedTotalValue,
              },
            ],
          },
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        const target = Array.isArray(err?.meta?.target) ? err.meta.target : [];
        if (target.includes('sourceAppointmentId') && appointmentId) {
          return prisma.invoice.findUnique({ where: { sourceAppointmentId: appointmentId } });
        }
        if (target.includes('sourceConsultationId') && consultationId) {
          return prisma.invoice.findUnique({ where: { sourceConsultationId: consultationId } });
        }
        if (target.includes('number')) {
          numberToUse = undefined;
          continue;
        }
      }
      throw err;
    }
  }

  return created;
};

type InventoryConsumptionSnapshot = {
  source: string;
  materials: Array<{
    inventoryItemId: string;
    quantity: number;
    consumedLots?: Array<{ lotId: string; lotCode?: string | null; quantity: number }>;
  }>;
};

const normalizeKitKey = (value?: string | null) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

const recomputeInventoryItemStatus = async (tx: any, inventoryItemId: string) => {
  const item = await tx.inventoryItem.findUnique({ where: { id: inventoryItemId } });
  if (!item) return;
  const minQuantity = Number.isFinite(Number(item.minQuantity)) ? Number(item.minQuantity) : 0;
  const nextStatus = item.quantity <= minQuantity ? 'LOW' : 'AVAILABLE';
  if ((item.status || '').toUpperCase() !== nextStatus) {
    await tx.inventoryItem.update({
      where: { id: item.id },
      data: { status: nextStatus },
    });
  }
};

const resolveProcedureMaterialRequirements = async (
  tx: any,
  appointment: { branchId?: string | null; specialty?: string | null; convenio?: string | null },
) => {
  const procedureName = String(appointment.specialty || '').trim();
  if (!procedureName) return { source: 'NONE', materials: [] as Array<{ inventoryItemId: string; quantity: number }> };

  const procedure = await tx.procedure.findFirst({
    where: {
      branchId: appointment.branchId || undefined,
      name: { equals: procedureName, mode: 'insensitive' },
    },
    include: {
      materials: true,
      kitBindings: {
        where: { isActive: true },
        include: {
          inventoryKit: {
            include: { items: true },
          },
        },
      },
      materialKits: {
        where: { isActive: true },
        include: { items: true },
      },
    },
  });
  if (!procedure) return { source: 'NONE', materials: [] as Array<{ inventoryItemId: string; quantity: number }> };

  const normalizedInsurance = normalizeKitKey(appointment.convenio);
  const kitBindings = Array.isArray((procedure as any).kitBindings) ? (procedure as any).kitBindings : [];
  const insuranceBinding = normalizedInsurance
    ? kitBindings.find((binding: any) => normalizeKitKey(binding.insuranceName) === normalizedInsurance)
    : null;
  const defaultBinding = kitBindings.find((binding: any) => !binding.insuranceName) || null;
  const selectedBinding = insuranceBinding || defaultBinding;

  if (selectedBinding?.inventoryKit?.items?.length) {
    return {
      source: `INVENTORY_KIT:${selectedBinding.inventoryKitId}`,
      materials: selectedBinding.inventoryKit.items
        .map((item: any) => ({
          inventoryItemId: String(item.inventoryItemId || '').trim(),
          quantity: Math.max(0, Number(item.quantity || 0)),
        }))
        .filter((item: any) => item.inventoryItemId && Number.isFinite(item.quantity) && item.quantity > 0),
    };
  }

  const kits = Array.isArray(procedure.materialKits) ? procedure.materialKits : [];
  const insuranceKit = normalizedInsurance
    ? kits.find((kit: any) => normalizeKitKey(kit.insuranceName) === normalizedInsurance)
    : null;
  const defaultKit = kits.find((kit: any) => !kit.insuranceName && kit.isDefault)
    || kits.find((kit: any) => !kit.insuranceName)
    || null;
  const selectedKit = insuranceKit || defaultKit;

  if (selectedKit && Array.isArray(selectedKit.items) && selectedKit.items.length > 0) {
    return {
      source: `KIT:${selectedKit.id}`,
      materials: selectedKit.items
        .map((item: any) => ({
          inventoryItemId: String(item.inventoryItemId || '').trim(),
          quantity: Math.max(0, Number(item.quantity || 0)),
        }))
        .filter((item: any) => item.inventoryItemId && Number.isFinite(item.quantity) && item.quantity > 0),
    };
  }

  const materials = Array.isArray(procedure.materials) ? procedure.materials : [];
  return {
    source: 'PROCEDURE_MATERIALS',
    materials: materials
      .map((item: any) => ({
        inventoryItemId: String(item.inventoryItemId || '').trim(),
        quantity: Math.max(0, Number(item.quantity || 0)),
      }))
      .filter((item: any) => item.inventoryItemId && Number.isFinite(item.quantity) && item.quantity > 0),
  };
};

const applyProcedureMaterialStock = async (
  tx: any,
  appointment: { branchId?: string | null; specialty?: string | null; convenio?: string | null },
  mode: 'consume' | 'revert',
  snapshot?: InventoryConsumptionSnapshot | null,
  options?: { actorUserId?: string | null; appointmentId?: string | null },
) => {
  const actorUserId = String(options?.actorUserId || '').trim() || null;
  const appointmentId = String(options?.appointmentId || '').trim() || null;
  let createdByName: string | null = null;
  if (actorUserId) {
    const [user, admin] = await Promise.all([
      tx.user.findUnique({ where: { id: actorUserId }, select: { name: true } }),
      tx.adminUser.findUnique({ where: { id: actorUserId }, select: { name: true } }),
    ]);
    createdByName = String(user?.name || admin?.name || '').trim() || null;
  }

  const resolved = mode === 'consume'
    ? await resolveProcedureMaterialRequirements(tx, appointment)
    : { source: snapshot?.source || 'UNKNOWN', materials: Array.isArray(snapshot?.materials) ? snapshot.materials : [] };
  const materials = Array.isArray(resolved.materials) ? resolved.materials : [];
  if (!materials.length) return null;

  const consumeLotsByFefo = async (
    inventoryItemId: string,
    requiredQuantity: number,
  ) => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const availableLots = await tx.inventoryLot.findMany({
      where: {
        inventoryItemId,
        quantity: { gt: 0 },
        OR: [
          { expiryDate: null },
          { expiryDate: { gte: todayStart } },
        ],
      },
      orderBy: [
        { expiryDate: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    if (!availableLots.length) {
      return {
        usedLots: false,
        remaining: requiredQuantity,
        consumedLots: [] as Array<{ lotId: string; lotCode?: string | null; quantity: number }>,
      };
    }

    let remaining = requiredQuantity;
    const consumedLots: Array<{ lotId: string; lotCode?: string | null; quantity: number }> = [];

    for (const lot of availableLots) {
      if (remaining <= 0) break;
      const consumeQty = Math.min(Number(lot.quantity || 0), remaining);
      if (consumeQty <= 0) continue;

      const updated = await tx.inventoryLot.updateMany({
        where: {
          id: lot.id,
          quantity: { gte: consumeQty },
        },
        data: {
          quantity: { decrement: consumeQty },
        },
      });
      if (updated.count === 0) continue;

      consumedLots.push({
        lotId: lot.id,
        lotCode: lot.lotCode || null,
        quantity: consumeQty,
      });
      remaining -= consumeQty;
    }

    return {
      usedLots: true,
      remaining,
      consumedLots,
    };
  };

  if (mode === 'consume') {
    const snapshotMaterials: InventoryConsumptionSnapshot['materials'] = [];

    for (const material of materials) {
      const before = await tx.inventoryItem.findUnique({ where: { id: material.inventoryItemId } });
      if (!before) {
        throw new Error(`Material não encontrado: ${material.inventoryItemId}`);
      }

      const fefo = await consumeLotsByFefo(material.inventoryItemId, material.quantity);
      if (fefo.usedLots && fefo.remaining > 0) {
        const itemName = before?.name || material.inventoryItemId;
        throw new Error(`Estoque insuficiente em lotes válidos para material "${itemName}".`);
      }

      const updated = await tx.inventoryItem.updateMany({
        where: {
          id: material.inventoryItemId,
          quantity: { gte: material.quantity },
        },
        data: { quantity: { decrement: material.quantity } },
      });

      if (updated.count === 0) {
        const item = await tx.inventoryItem.findUnique({ where: { id: material.inventoryItemId } });
        const name = item?.name || material.inventoryItemId;
        throw new Error(`Estoque insuficiente para material "${name}".`);
      }

      const after = await tx.inventoryItem.findUnique({ where: { id: material.inventoryItemId } });
      if (after) {
        const lotsNote = fefo.consumedLots.length
          ? `lots:${fefo.consumedLots.map((lot) => `${lot.lotCode || lot.lotId}(${lot.quantity})`).join(',')}`
          : null;
        await tx.inventoryMovement.create({
          data: {
            inventoryItemId: material.inventoryItemId,
            type: 'EXIT',
            quantity: material.quantity,
            reason: 'Consumo automático por conclusão do atendimento',
            notes: [appointmentId ? `appointment:${appointmentId}` : null, `source:${resolved.source}`, lotsNote].filter(Boolean).join(' | ') || null,
            previousQty: Number(before.quantity || 0),
            resultingQty: Number(after.quantity || 0),
            createdByUserId: actorUserId,
            createdByName,
          },
        });
      }

      await recomputeInventoryItemStatus(tx, material.inventoryItemId);

      snapshotMaterials.push({
        inventoryItemId: material.inventoryItemId,
        quantity: material.quantity,
        consumedLots: fefo.consumedLots.length ? fefo.consumedLots : undefined,
      });
    }

    return {
      source: resolved.source,
      materials: snapshotMaterials,
    } satisfies InventoryConsumptionSnapshot;
  }

  for (const material of materials) {
    const before = await tx.inventoryItem.findUnique({ where: { id: material.inventoryItemId } });
    if (!before) continue;

    await tx.inventoryItem.update({
      where: { id: material.inventoryItemId },
      data: { quantity: { increment: material.quantity } },
    });

    const consumedLots = Array.isArray(material.consumedLots) ? material.consumedLots : [];
    for (const consumedLot of consumedLots) {
      const lotId = String(consumedLot?.lotId || '').trim();
      const quantity = Number(consumedLot?.quantity || 0);
      if (!lotId || !Number.isFinite(quantity) || quantity <= 0) continue;
      await tx.inventoryLot.updateMany({
        where: { id: lotId },
        data: { quantity: { increment: quantity } },
      });
    }

    const after = await tx.inventoryItem.findUnique({ where: { id: material.inventoryItemId } });
    if (after) {
      const lotsNote = consumedLots.length
        ? `lots:${consumedLots.map((lot: any) => `${lot?.lotCode || lot?.lotId || 'lot'}(${Number(lot?.quantity || 0)})`).join(',')}`
        : null;
      await tx.inventoryMovement.create({
        data: {
          inventoryItemId: material.inventoryItemId,
          type: 'ENTRY',
          quantity: material.quantity,
          reason: 'Estorno automático por reabertura/cancelamento do atendimento',
          notes: [appointmentId ? `appointment:${appointmentId}` : null, `source:${resolved.source}`, lotsNote].filter(Boolean).join(' | ') || null,
          previousQty: Number(before.quantity || 0),
          resultingQty: Number(after.quantity || 0),
          createdByUserId: actorUserId,
          createdByName,
        },
      });
    }

    await recomputeInventoryItemStatus(tx, material.inventoryItemId);
  }

  return null;
};

export default async function consultationRoutes(app: FastifyInstance) {
  const getLoggedContext = async (request: any) => {
    const userId = (request.user as any)?.id;
    if (!userId) return null;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        sector: { include: { branch: true } },
        doctor: { select: { id: true, name: true } },
        accesses: { include: { modules: { select: { name: true } } } },
      },
    });
    const canViewConsultationModule = Boolean(
      user?.accesses?.some((access: any) => access.modules?.some((module: any) => module.name === 'consulta')),
    );
    return {
      branchId: user?.sector?.branch?.id || null,
      doctorId: user?.doctor?.id || null,
      doctorName: user?.doctor?.name || null,
      canViewConsultationModule,
    };
  };

  const getExamOrderBranchSettings = async (branchId: string) => {
    const settings = await prisma.branchSettings.upsert({
      where: { branchId },
      update: {},
      create: { branchId },
      select: { doctorCanScheduleExamFromConsultation: true },
    });
    return {
      doctorCanScheduleExamFromConsultation: Boolean(settings?.doctorCanScheduleExamFromConsultation),
    };
  };

  const resolveAvailableExamSlots = async (params: {
    branchId: string;
    procedureId: string;
    doctorId?: string | null;
    doctorName?: string | null;
    durationMinutes?: number | null;
    limit?: number;
  }) => {
    const limit = Math.max(3, Math.min(Number(params.limit || 5), 5));
    const duration = Number.isFinite(Number(params.durationMinutes)) && Number(params.durationMinutes) > 0
      ? Number(params.durationMinutes)
      : 30;
    const doctorName = String(params.doctorName || '').trim();
    if (!doctorName && !params.doctorId) return [] as Array<any>;

    const doctor = params.doctorId
      ? await prisma.doctor.findFirst({
          where: { id: String(params.doctorId), isActive: true },
          select: { id: true, name: true, roomId: true, roomLinks: { select: { roomId: true } } },
        })
      : await prisma.doctor.findFirst({
          where: {
            branchId: params.branchId,
            name: { equals: doctorName, mode: 'insensitive' },
            isActive: true,
          },
          select: { id: true, name: true, roomId: true, roomLinks: { select: { roomId: true } } },
        });
    if (!doctor) return [] as Array<any>;

    const roomIds = Array.from(new Set([
      String(doctor.roomId || '').trim(),
      ...((doctor.roomLinks || []).map((link: any) => String(link.roomId || '').trim())),
    ].filter(Boolean)));
    if (roomIds.length === 0) return [] as Array<any>;

    const equipmentLinks = await prisma.medicalEquipmentProcedure.findMany({
      where: { procedureId: String(params.procedureId) },
      include: {
        medicalEquipment: {
          select: {
            id: true,
            branchId: true,
            roomId: true,
            name: true,
            status: true,
            isActive: true,
          },
        },
      },
    });

    const eligibleResources = equipmentLinks
      .map((link: any) => link.medicalEquipment)
      .filter((eq: any) => eq
        && eq.isActive
        && String(eq.branchId || '') === String(params.branchId)
        && eq.roomId
        && roomIds.includes(String(eq.roomId))
        && !['INATIVO', 'MANUTENCAO', 'MANUTENÇÃO'].includes(normalizeStatusKey(eq.status || '')));
    if (eligibleResources.length === 0) return [] as Array<any>;

    const equipmentIds = eligibleResources.map((eq: any) => String(eq.id));

    const now = new Date();
    const suggested: Array<{
      date: string;
      time: string;
      roomId: string;
      medicalEquipmentId: string;
      roomName?: string | null;
      medicalEquipmentName?: string | null;
    }> = [];

    for (let dayOffset = 0; dayOffset < 30 && suggested.length < limit; dayOffset += 1) {
      const day = new Date(now);
      day.setDate(now.getDate() + dayOffset);
      const weekDay = day.getDay();
      if (weekDay === 0) continue;

      const dateIso = formatDateToIso(day);
      const appointments = await prisma.appointment.findMany({
        where: {
          branchId: params.branchId,
          date: dateIso,
          isActive: true,
          OR: [
            { doctorName: { equals: doctor.name, mode: 'insensitive' } },
            { roomId: { in: roomIds } },
            { medicalEquipmentId: { in: equipmentIds } },
          ],
        },
        select: { time: true, durationMinutes: true, status: true, doctorName: true, roomId: true, medicalEquipmentId: true },
      });

      const busy = appointments.filter((item: any) =>
        !NON_BLOCKING_APPOINTMENT_STATUSES.has(normalizeStatusKey(item?.status || '')));

      const startHour = 8;
      const endHour = 18;
      for (let hour = startHour; hour < endHour && suggested.length < limit; hour += 1) {
        for (const minute of [0, 30]) {
          const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
          if (dayOffset === 0) {
            const slotDate = new Date(`${dateIso}T${time}:00`);
            if (slotDate <= now) continue;
          }

          const doctorConflict = busy
            .filter((item: any) => String(item?.doctorName || '').trim().toLowerCase() === String(doctor.name || '').trim().toLowerCase())
            .some((item: any) => rangesOverlap(time, duration, item?.time, item?.durationMinutes));
          if (doctorConflict) continue;

          const availableResource = eligibleResources.find((resource: any) => {
            const roomConflict = busy
              .filter((item: any) => String(item?.roomId || '') === String(resource.roomId || ''))
              .some((item: any) => rangesOverlap(time, duration, item?.time, item?.durationMinutes));
            if (roomConflict) return false;
            const equipmentConflict = busy
              .filter((item: any) => String(item?.medicalEquipmentId || '') === String(resource.id || ''))
              .some((item: any) => rangesOverlap(time, duration, item?.time, item?.durationMinutes));
            return !equipmentConflict;
          });

          if (availableResource) {
            suggested.push({
              date: dateIso,
              time,
              roomId: String(availableResource.roomId),
              medicalEquipmentId: String(availableResource.id),
              roomName: null,
              medicalEquipmentName: availableResource.name || null,
            });
            if (suggested.length >= limit) {
              break;
            }
          }
        }
      }
    }

    const roomIdsUsed = Array.from(new Set(suggested.map((slot) => slot.roomId)));
    const rooms = roomIdsUsed.length
      ? await prisma.sector.findMany({
          where: { id: { in: roomIdsUsed } },
          select: { id: true, name: true },
        })
      : [];
    const roomById = new Map<string, any>(rooms.map((room: any) => [String(room.id), room]));

    for (const slot of suggested) {
      slot.roomName = roomById.get(String(slot.roomId))?.name || null;
    }

    return suggested;
  };

  app.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  app.get('/', {
    schema: {
      summary: 'List consultations',
      tags: ['Consultations'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          convenioStatus: { type: 'string' },
          queueType: { type: 'string' },
          includeCompleted: { type: 'boolean', default: false },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    await applyAutomaticNoShowForBranchInConsultationQueue(branchId);

    const { search, convenioStatus, queueType, includeCompleted = false, limit = 50, offset = 0 } = request.query as any;

    const where: any = { isActive: true, branchId };
    if (context?.doctorId || context?.doctorName) {
      where.AND = [
        {
          OR: [
            ...(context?.doctorId ? [{ doctorId: context.doctorId }] : []),
            ...(context?.doctorName ? [{ doctorName: context.doctorName }] : []),
          ],
        },
      ];
    }
    if (convenioStatus) where.convenioStatus = convenioStatus;
    if (queueType) where.queueType = queueType;
    if (search) {
      const searchOr = [
        { patientName: { contains: search, mode: 'insensitive' } },
        { convenio: { contains: search, mode: 'insensitive' } },
        { doctorName: { contains: search, mode: 'insensitive' } },
      ];
      if (where.AND) {
        where.AND.push({ OR: searchOr });
      } else {
        where.OR = searchOr;
      }
    }

    const [items, total] = await Promise.all([
      prisma.consultation.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
        include: {
          appointment: {
            select: {
              id: true,
              specialty: true,
              type: true,
              date: true,
              time: true,
              observations: true,
              status: true,
              patientId: true,
              patientCpf: true,
              patientName: true,
            },
          },
          nursingResponse: {
            include: { answers: true },
          },
        },
      }),
      prisma.consultation.count({ where }),
    ]);

    const nowDate = getTodayDateString();
    const nowTime = getNowTimeString();
    const reportInsights = await resolveConsultationExamInsights(branchId, items as any[]);
    const dicomInsights = await resolveConsultationDicomInsights(branchId, items as any[]);
    const enriched = await Promise.all(items.map(async (item: any) => {
      const nursingTemplate = item.appointment
        ? await resolveNursingTemplateForAppointment(branchId, item.appointment)
        : null;
      const patientId = String(item?.appointment?.patientId || '').trim();
      const patientCpf = String(item?.appointment?.patientCpf || '').replace(DIGITS_ONLY_REGEX, '').trim();
      const patientName = String(item?.appointment?.patientName || item?.patientName || '').trim().toLowerCase();
      const appointmentId = String(item?.appointment?.id || item?.appointmentId || '').trim();
      const dicomInsight = appointmentId ? dicomInsights.get(appointmentId) : null;
      const latestExamImage = dicomInsight?.worklist || null;
      const hasExamImageReceived = Boolean(dicomInsight?.hasImage);
      const relatedReports = [
        ...(patientId ? (reportInsights.get(`id:${patientId}`) || []) : []),
        ...(patientCpf ? (reportInsights.get(`cpf:${patientCpf}`) || []) : []),
        ...(patientName ? (reportInsights.get(`name:${patientName}`) || []) : []),
      ].filter(Boolean);
      const finalReports = relatedReports.filter((report: any) => isFinalizedReportStatus(report?.status));
      const latestFinalReport = finalReports
        .sort((a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] || null;
      const hasExamImagesAvailable = Boolean(
        latestFinalReport?.worklistItem?.dicomStudyUid
        || latestFinalReport?.worklistItem?.dicomUrl
        || latestFinalReport?.worklistItem?.dicomReceivedAt,
      );
      return toConsultationView({
        ...item,
        hasExamImageReceived,
        latestExamImage: latestExamImage
          ? {
              id: latestExamImage.id,
              appointmentId: latestExamImage.appointmentId || null,
              dicomStudyUid: latestExamImage.dicomStudyUid || null,
              dicomUrl: latestExamImage.dicomUrl || null,
              dicomReceivedAt: latestExamImage.dicomReceivedAt || null,
            }
          : null,
        hasFinalizedExamReport: Boolean(latestFinalReport),
        hasExamImagesAvailable,
        latestFinalizedExamReport: latestFinalReport
          ? {
              id: latestFinalReport.id,
              status: latestFinalReport.status,
              exam: latestFinalReport.exam || null,
              updatedAt: latestFinalReport.updatedAt,
              appointmentId: latestFinalReport.appointmentId || null,
              worklistItemId: latestFinalReport.worklistItem?.id || null,
              dicomStudyUid: latestFinalReport.worklistItem?.dicomStudyUid || null,
              dicomUrl: latestFinalReport.worklistItem?.dicomUrl || null,
              dicomReceivedAt: latestFinalReport.worklistItem?.dicomReceivedAt || null,
            }
          : null,
        nursingTemplate: nursingTemplate
          ? {
              id: nursingTemplate.id,
              name: nursingTemplate.name,
              description: nursingTemplate.description,
              collectHeight: nursingTemplate.collectHeight,
              collectWeight: nursingTemplate.collectWeight,
              collectBloodPressure: nursingTemplate.collectBloodPressure,
              collectTemperature: nursingTemplate.collectTemperature,
              collectHeartRate: nursingTemplate.collectHeartRate,
              collectOxygenSaturation: nursingTemplate.collectOxygenSaturation,
              collectGlucose: nursingTemplate.collectGlucose,
              collectPregnancyCheck: nursingTemplate.collectPregnancyCheck,
              questions: nursingTemplate.questions || [],
            }
          : null,
      });
    }));

    const visibleItems = enriched.filter((item: any) => {
      if (includeCompleted) return true;
      if (isTerminalClinicalQueueStatus(item.queue)) return false;
      if (item.appointment && isTerminalAppointmentStatus(item.appointment.status)) return false;

      const appointmentDate = String(item?.appointment?.date || '').trim();
      const appointmentTime = String(item?.appointment?.time || '').trim();
      const appointmentStatus = normalizeAppointmentStatusKey(item?.appointment?.status || '');
      const canExpireByTime = APPOINTMENT_NO_SHOW_UPDATABLE_STATUS_KEYS.has(appointmentStatus);
      if (canExpireByTime && appointmentDate && appointmentTime) {
        if (appointmentDate < nowDate) return false;
        if (appointmentDate === nowDate && appointmentTime <= nowTime) return false;
      }

      return true;
    });

    return { items: visibleItems, total: visibleItems.length };
  });

  // History endpoint — completed consultations for the logged doctor only
  app.get('/historico', {
    schema: {
      summary: 'List completed consultations for the logged doctor',
      tags: ['Consultations'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          type: { type: 'string' },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          limit: { type: 'number', default: 20 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    // Doctors see their own history; authorized clinical staff can see the branch history.
    if (!context?.doctorId && !context?.doctorName && !context?.canViewConsultationModule) {
      return (reply as any).code(403).send({ error: 'Usuário sem acesso ao histórico de atendimentos' });
    }

    const { search, type, startDate, endDate, limit = 20, offset = 0 } = request.query as any;

    const where: any = {
      isActive: true,
      branchId,
      appointment: {
        status: { in: ['REALIZADO', 'FINALIZADO', 'COMPLETED', 'ATENDIDO'] },
      },
    };

    if (context.doctorId || context.doctorName) {
      where.OR = [
        ...(context.doctorId ? [{ doctorId: context.doctorId }] : []),
        ...(context.doctorName ? [{ doctorName: context.doctorName }] : []),
      ];
    }

    if (search) {
      where.AND = [
        {
          OR: [
            { patientName: { contains: search, mode: 'insensitive' } },
            { convenio: { contains: search, mode: 'insensitive' } },
          ],
        },
      ];
    }

    if (type) {
      where.appointment = { ...where.appointment, type: { equals: type, mode: 'insensitive' } };
    }

    if (startDate || endDate) {
      where.appointment = {
        ...where.appointment,
        date: {
          ...(startDate ? { gte: startDate } : {}),
          ...(endDate ? { lte: endDate } : {}),
        },
      };
    }

    const [items, total] = await Promise.all([
      prisma.consultation.findMany({
        where,
        take: Number(limit),
        skip: Number(offset),
        orderBy: [{ appointment: { date: 'desc' } }, { createdAt: 'desc' }],
        include: {
          appointment: {
            select: {
              id: true,
              specialty: true,
              type: true,
              date: true,
              time: true,
              status: true,
              observations: true,
              patientId: true,
              patientCpf: true,
              patientName: true,
              convenio: true,
              durationMinutes: true,
            },
          },
          medicalRecord: {
            select: {
              id: true,
              chiefComplaint: true,
              diagnosis: true,
              treatment: true,
              prescriptions: true,
              examRequests: true,
              notes: true,
              riskClassification: true,
            },
          },
        },
      }),
      prisma.consultation.count({ where }),
    ]);

    return {
      items: items.map((item: any) => ({
        id: item.id,
        patientName: item.patientName || item.appointment?.patientName || null,
        doctorName: item.doctorName || null,
        convenio: item.convenio || item.appointment?.convenio || null,
        date: item.appointment?.date || null,
        time: item.appointment?.time || null,
        type: item.appointment?.type || null,
        specialty: item.appointment?.specialty || null,
        appointmentStatus: item.appointment?.status || null,
        appointmentId: item.appointment?.id || item.appointmentId || null,
        isTeleconsultation: isTeleconsultationAppointment(item.appointment),
        hasMedicalRecord: Boolean(item.medicalRecord),
        chiefComplaint: item.medicalRecord?.chiefComplaint || item.mainComplaint || null,
        diagnosis: item.medicalRecord?.diagnosis || null,
      })),
      total,
    };
  });

  app.get('/:id', {
    schema: {
      summary: 'Get consultation by ID',
      tags: ['Consultations'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const item = await prisma.consultation.findFirst({
      where: {
        id,
        branchId,
        ...((context?.doctorId || context?.doctorName)
          ? {
              OR: [
                ...(context?.doctorId ? [{ doctorId: context.doctorId }] : []),
                ...(context?.doctorName ? [{ doctorName: context.doctorName }] : []),
              ],
            }
          : {}),
      },
      include: {
        appointment: {
          select: {
            id: true,
            specialty: true,
            type: true,
            date: true,
            time: true,
            observations: true,
            patientId: true,
            patientCpf: true,
            patientName: true,
            convenio: true,
            durationMinutes: true,
            status: true,
            attachments: {
              select: {
                id: true,
                fileName: true,
                mimeType: true,
                sizeBytes: true,
                uploadedAt: true,
              },
            },
          },
        },
        nursingResponse: {
          include: { answers: true },
        },
        medicalRecord: {
          select: {
            id: true,
            riskClassification: true,
            chiefComplaint: true,
            historyOfPresentIllness: true,
            physicalExamination: true,
            diagnosis: true,
            treatment: true,
            prescriptions: true,
            examRequests: true,
            notes: true,
            bloodPressureSystolic: true,
            bloodPressureDiastolic: true,
            heartRate: true,
            respiratoryRate: true,
            temperature: true,
            oxygenSaturation: true,
            weight: true,
            height: true,
            bmi: true,
            recordDate: true,
          },
        },
      },
    });
    if (!item) return reply.code(404).send({ error: 'Consultation not found' });
    const nursingTemplate = item.appointment
      ? await resolveNursingTemplateForAppointment(branchId, item.appointment)
      : null;
    const reportInsights = await resolveConsultationExamInsights(branchId, [item] as any[]);
    const dicomInsights = await resolveConsultationDicomInsights(branchId, [item] as any[]);
    const patientId = String(item?.appointment?.patientId || '').trim();
    const patientCpf = String(item?.appointment?.patientCpf || '').replace(DIGITS_ONLY_REGEX, '').trim();
    const patientName = String(item?.appointment?.patientName || item?.patientName || '').trim().toLowerCase();
    const appointmentId = String(item?.appointment?.id || item?.appointmentId || '').trim();
    const dicomInsight = appointmentId ? dicomInsights.get(appointmentId) : null;
    const latestExamImage = dicomInsight?.worklist || null;
    const hasExamImageReceived = Boolean(dicomInsight?.hasImage);
    const relatedReports = [
      ...(patientId ? (reportInsights.get(`id:${patientId}`) || []) : []),
      ...(patientCpf ? (reportInsights.get(`cpf:${patientCpf}`) || []) : []),
      ...(patientName ? (reportInsights.get(`name:${patientName}`) || []) : []),
    ].filter(Boolean);
    const finalReports = relatedReports.filter((report: any) => isFinalizedReportStatus(report?.status));
    const latestFinalReport = finalReports
      .sort((a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] || null;
    const hasExamImagesAvailable = Boolean(
      latestFinalReport?.worklistItem?.dicomStudyUid
      || latestFinalReport?.worklistItem?.dicomUrl
      || latestFinalReport?.worklistItem?.dicomReceivedAt,
    );
    return toConsultationView({
      ...item,
      hasExamImageReceived,
      latestExamImage: latestExamImage
        ? {
            id: latestExamImage.id,
            appointmentId: latestExamImage.appointmentId || null,
            dicomStudyUid: latestExamImage.dicomStudyUid || null,
            dicomUrl: latestExamImage.dicomUrl || null,
            dicomReceivedAt: latestExamImage.dicomReceivedAt || null,
          }
        : null,
      hasFinalizedExamReport: Boolean(latestFinalReport),
      hasExamImagesAvailable,
      latestFinalizedExamReport: latestFinalReport
        ? {
            id: latestFinalReport.id,
            status: latestFinalReport.status,
            exam: latestFinalReport.exam || null,
            updatedAt: latestFinalReport.updatedAt,
            appointmentId: latestFinalReport.appointmentId || null,
            worklistItemId: latestFinalReport.worklistItem?.id || null,
            dicomStudyUid: latestFinalReport.worklistItem?.dicomStudyUid || null,
            dicomUrl: latestFinalReport.worklistItem?.dicomUrl || null,
            dicomReceivedAt: latestFinalReport.worklistItem?.dicomReceivedAt || null,
          }
        : null,
      nursingTemplate: nursingTemplate
        ? {
            id: nursingTemplate.id,
            name: nursingTemplate.name,
            description: nursingTemplate.description,
            collectHeight: nursingTemplate.collectHeight,
            collectWeight: nursingTemplate.collectWeight,
            collectBloodPressure: nursingTemplate.collectBloodPressure,
            collectTemperature: nursingTemplate.collectTemperature,
            collectHeartRate: nursingTemplate.collectHeartRate,
            collectOxygenSaturation: nursingTemplate.collectOxygenSaturation,
            collectGlucose: nursingTemplate.collectGlucose,
            collectPregnancyCheck: nursingTemplate.collectPregnancyCheck,
            questions: nursingTemplate.questions || [],
          }
        : null,
    });
  });

  app.post('/', {
    schema: {
      summary: 'Create consultation',
      tags: ['Consultations'],
      body: {
        type: 'object',
        required: ['patientName'],
        properties: {
          patientName: { type: 'string' },
          appointmentId: { type: 'string' },
          doctorId: { type: 'string' },
          doctorName: { type: 'string' },
          convenio: { type: 'string' },
          convenioStatus: { type: 'string' },
          scheduledFor: { type: 'string' },
          queueType: { type: 'string' },
          agenda: { type: 'string' },
          totem: { type: 'string' },
          queue: { type: 'string' },
          bloodPressure: { type: 'string' },
          heartRate: { type: 'string' },
          temperature: { type: 'string' },
          oxygenSaturation: { type: 'string' },
          weight: { type: 'string' },
          height: { type: 'string' },
          glucose: { type: 'string' },
          bmi: { type: 'string' },
          anamnese: { type: 'string' },
          mainComplaint: { type: 'string' },
          diseaseHistory: { type: 'string' },
          allergies: { type: 'string' },
          medications: { type: 'string' },
          antecedentes: { type: 'string' },
          pregnant: { type: 'string' },
          triageNotes: { type: 'string' },
        },
      },
      response: {
        201: { type: 'object' },
        400: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;
    try {
      const linkedAppointment = data?.appointmentId
        ? await prisma.appointment.findFirst({
            where: { id: String(data.appointmentId), branchId, isActive: true },
            select: { id: true, specialty: true, type: true, date: true, time: true, observations: true },
          })
        : null;
      const nursingTemplate = linkedAppointment
        ? await resolveNursingTemplateForAppointment(branchId, linkedAppointment)
        : null;
      const defaultQueue = isExamAppointment(linkedAppointment?.type)
        ? (nursingTemplate ? 'Aguardando triagem' : 'Aguardando exame')
        : 'Aguardando atendimento';
      const resolvedQueue = isExamAppointment(linkedAppointment?.type)
        ? defaultQueue
        : (nursingTemplate ? defaultQueue : (data.queue || defaultQueue));

      const isClinicalQueueCreate = canonicalClinicalQueueStatus(data?.queueType) === 'FILA_CLINICA';
      if (isClinicalQueueCreate) {
        if (data?.appointmentId) {
          const existingByAppointment = await prisma.consultation.findFirst({
            where: {
              branchId,
              isActive: true,
              queueType: data.queueType || null,
              appointmentId: data.appointmentId,
            },
            orderBy: { createdAt: 'desc' },
          });
          if (existingByAppointment) {
            return reply.code(201).send(existingByAppointment);
          }
        }

        const existingToday = await prisma.consultation.findFirst({
          where: {
            branchId,
            isActive: true,
            queueType: data.queueType || null,
            patientName: data.patientName || null,
            doctorName: data.doctorName || null,
            agenda: data.agenda || null,
            createdAt: {
              gte: new Date(new Date().setHours(0, 0, 0, 0)),
              lte: new Date(new Date().setHours(23, 59, 59, 999)),
            },
          },
          orderBy: { createdAt: 'desc' },
        });

        if (existingToday) {
          return reply.code(201).send(existingToday);
        }
      }

      const item = await prisma.consultation.create({ data: {
        branchId,
        doctorId: data.doctorId || null,
        appointmentId: data.appointmentId || null,
        doctorName: data.doctorName || null,
        patientName: data.patientName,
        convenio: data.convenio || null,
        convenioStatus: data.convenioStatus || null,
        scheduledFor: data.scheduledFor || null,
        queueType: data.queueType || null,
        agenda: data.agenda || null,
        totem: data.totem || null,
        queue: resolvedQueue,
        bloodPressure: data.bloodPressure || null,
        heartRate: data.heartRate || null,
        temperature: data.temperature || null,
        oxygenSaturation: data.oxygenSaturation || null,
        weight: data.weight || null,
        height: data.height || null,
        glucose: data.glucose || null,
        bmi: data.bmi || null,
        anamnese: data.anamnese || null,
        mainComplaint: data.mainComplaint || null,
        diseaseHistory: data.diseaseHistory || null,
        allergies: data.allergies || null,
        medications: data.medications || null,
        antecedentes: data.antecedentes || null,
        pregnant: data.pregnant || null,
        triageNotes: data.triageNotes || null,
      } });

      return reply.code(201).send(item);
    } catch (err: any) {
      request.log.error({ err }, 'Failed to create consultation');
      return reply.code(400).send({ error: 'Failed to create consultation', details: err.message });
    }
  });

  app.post('/:id/nursing-triage', {
    schema: {
      summary: 'Submit nursing triage for consultation',
      tags: ['Consultations'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object' },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const data = request.body as any;

    const consultation = await prisma.consultation.findFirst({
      where: { id, branchId, isActive: true },
      include: {
        appointment: {
          select: { id: true, specialty: true, type: true, date: true, time: true, observations: true },
        },
        nursingResponse: true,
      },
    });
    if (!consultation) return reply.code(404).send({ error: 'Consultation not found' });
    if (!consultation.appointment || !isExamAppointment(consultation.appointment.type)) {
      return reply.code(400).send({ error: 'A triagem de enfermagem só está disponível para agendamentos de exame' });
    }

    const nursingTemplate = await resolveNursingTemplateForAppointment(branchId, consultation.appointment);
    if (!nursingTemplate) {
      return reply.code(404).send({ error: 'Não há triagem cadastrada para este procedimento' });
    }

    const answers = normalizeNursingAnswers(data?.answers);
    const answerLabels = new Set(answers.map((answer: any) => answer.questionLabel));

    const missingQuestions = (nursingTemplate.questions || []).filter((question: any) => {
      if (!question?.isRequired) return false;
      return !answerLabels.has(String(question.label || ''));
    });

    const missingStandardFields = [
      nursingTemplate.collectBloodPressure && !String(data?.bloodPressure || consultation.bloodPressure || '').trim() ? 'pressão arterial' : null,
      nursingTemplate.collectHeartRate && !String(data?.heartRate || consultation.heartRate || '').trim() ? 'frequência cardíaca' : null,
      nursingTemplate.collectTemperature && !String(data?.temperature || consultation.temperature || '').trim() ? 'temperatura' : null,
      nursingTemplate.collectOxygenSaturation && !String(data?.oxygenSaturation || consultation.oxygenSaturation || '').trim() ? 'saturação' : null,
      nursingTemplate.collectWeight && !String(data?.weight || consultation.weight || '').trim() ? 'peso' : null,
      nursingTemplate.collectHeight && !String(data?.height || consultation.height || '').trim() ? 'altura' : null,
      nursingTemplate.collectGlucose && !String(data?.glucose || consultation.glucose || '').trim() ? 'glicemia' : null,
      nursingTemplate.collectPregnancyCheck && !String(data?.pregnant || consultation.pregnant || '').trim() ? 'checagem de gestação' : null,
    ].filter(Boolean);

    if (missingQuestions.length > 0 || missingStandardFields.length > 0) {
      return reply.code(400).send({
        error: 'Preencha todos os campos obrigatórios da triagem antes de concluir',
        missingQuestions: missingQuestions.map((question: any) => question.label),
        missingStandardFields,
      });
    }

    const item = await prisma.$transaction(async (tx: any) => {
      if (consultation.nursingResponse?.id) {
        await tx.consultationNursingAnswer.deleteMany({
          where: { responseId: consultation.nursingResponse.id },
        });
        await tx.consultationNursingResponse.delete({
          where: { id: consultation.nursingResponse.id },
        });
      }

      const response = await tx.consultationNursingResponse.create({
        data: {
          consultationId: consultation.id,
          templateId: nursingTemplate.id,
          templateName: nursingTemplate.name,
        },
      });

      if (answers.length > 0) {
        await tx.consultationNursingAnswer.createMany({
          data: answers.map((answer: any) => ({
            responseId: response.id,
            questionId: answer.questionId,
            questionLabel: answer.questionLabel,
            responseType: answer.responseType,
            answerText: answer.answerText,
            answerValues: answer.answerValues,
            answerBoolean: answer.answerBoolean,
            answerNumber: answer.answerNumber,
            orderIndex: answer.orderIndex,
          })),
        });
      }

      return tx.consultation.update({
        where: { id: consultation.id },
        data: {
          bloodPressure: data?.bloodPressure !== undefined ? (data.bloodPressure || null) : consultation.bloodPressure,
          heartRate: data?.heartRate !== undefined ? (data.heartRate || null) : consultation.heartRate,
          temperature: data?.temperature !== undefined ? (data.temperature || null) : consultation.temperature,
          oxygenSaturation: data?.oxygenSaturation !== undefined ? (data.oxygenSaturation || null) : consultation.oxygenSaturation,
          weight: data?.weight !== undefined ? (data.weight || null) : consultation.weight,
          height: data?.height !== undefined ? (data.height || null) : consultation.height,
          glucose: data?.glucose !== undefined ? (data.glucose || null) : consultation.glucose,
          pregnant: data?.pregnant !== undefined ? (data.pregnant || null) : consultation.pregnant,
          triageNotes: data?.triageNotes !== undefined ? (data.triageNotes || null) : consultation.triageNotes,
          triageCompletedAt: new Date(),
          queue: 'Aguardando exame',
        },
        include: {
          appointment: {
            select: { id: true, specialty: true, type: true, date: true, time: true, observations: true },
          },
          nursingResponse: {
            include: { answers: true },
          },
        },
      });
    });

    return toConsultationView({
      ...item,
      nursingTemplate: {
        id: nursingTemplate.id,
        name: nursingTemplate.name,
        description: nursingTemplate.description,
        collectHeight: nursingTemplate.collectHeight,
        collectWeight: nursingTemplate.collectWeight,
        collectBloodPressure: nursingTemplate.collectBloodPressure,
        collectTemperature: nursingTemplate.collectTemperature,
        collectHeartRate: nursingTemplate.collectHeartRate,
        collectOxygenSaturation: nursingTemplate.collectOxygenSaturation,
        collectGlucose: nursingTemplate.collectGlucose,
        collectPregnancyCheck: nursingTemplate.collectPregnancyCheck,
        questions: nursingTemplate.questions || [],
      },
    });
  });

  app.get('/exam-order-config', {
    schema: {
      summary: 'Get exam order configuration for the branch',
      tags: ['Consultations'],
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });
    return getExamOrderBranchSettings(branchId);
  });

  app.put('/exam-order-config', {
    schema: {
      summary: 'Update exam order configuration for the branch',
      tags: ['Consultations'],
      body: {
        type: 'object',
        required: ['doctorCanScheduleExamFromConsultation'],
        properties: {
          doctorCanScheduleExamFromConsultation: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;
    const updated = await prisma.branchSettings.upsert({
      where: { branchId },
      update: {
        doctorCanScheduleExamFromConsultation: Boolean(data?.doctorCanScheduleExamFromConsultation),
      },
      create: {
        branchId,
        doctorCanScheduleExamFromConsultation: Boolean(data?.doctorCanScheduleExamFromConsultation),
      },
      select: { doctorCanScheduleExamFromConsultation: true },
    });

    return {
      doctorCanScheduleExamFromConsultation: Boolean(updated?.doctorCanScheduleExamFromConsultation),
    };
  });

  app.get('/:id/exam-procedures', {
    schema: {
      summary: 'List exam procedures available to consultation context',
      tags: ['Consultations'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const consultation = await prisma.consultation.findFirst({
      where: { id, branchId, isActive: true },
      select: { id: true, doctorId: true },
    });
    if (!consultation) return reply.code(404).send({ error: 'Consultation not found' });

    const doctorId = String(consultation.doctorId || context?.doctorId || '').trim();
    const procedures = await prisma.procedure.findMany({
      where: {
        branchId,
        isActive: true,
        appointmentType: { in: ['EXAME', 'EXAM'] },
      },
      include: { doctors: { select: { doctorId: true } } },
      orderBy: { name: 'asc' },
      take: 300,
    });

    const filtered = doctorId
      ? procedures.filter((item: any) => item.doctors.length === 0 || item.doctors.some((link: any) => String(link.doctorId) === doctorId))
      : procedures;

    return {
      items: filtered.map((item: any) => ({
        id: item.id,
        name: item.name,
        durationMinutes: item.durationMinutes || 30,
        price: item.price || null,
      })),
      total: filtered.length,
    };
  });

  app.get('/:id/exam-slots', {
    schema: {
      summary: 'Suggest available exam slots for doctor scheduling',
      tags: ['Consultations'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      querystring: {
        type: 'object',
        required: ['procedureId'],
        properties: {
          procedureId: { type: 'string' },
          limit: { type: 'number', default: 5 },
        },
      },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const { procedureId, limit = 5 } = request.query as any;
    const settings = await getExamOrderBranchSettings(branchId);
    if (!settings.doctorCanScheduleExamFromConsultation) {
      return reply.code(403).send({ error: 'Doctor scheduling from consultation is disabled for this branch' });
    }

    const consultation = await prisma.consultation.findFirst({
      where: { id, branchId, isActive: true },
      include: { appointment: true },
    });
    if (!consultation) return reply.code(404).send({ error: 'Consultation not found' });

    const procedure = await prisma.procedure.findFirst({
      where: {
        id: String(procedureId),
        branchId,
        isActive: true,
        appointmentType: { in: ['EXAME', 'EXAM'] },
      },
      select: { id: true, name: true, durationMinutes: true },
    });
    if (!procedure) return reply.code(404).send({ error: 'Procedure not found' });

    const doctorName = String(consultation.doctorName || consultation.appointment?.doctorName || '').trim();
    const slots = await resolveAvailableExamSlots({
      branchId,
      procedureId: procedure.id,
      doctorId: consultation.doctorId || context?.doctorId || null,
      doctorName,
      durationMinutes: procedure.durationMinutes || 30,
      limit,
    });

    return {
      procedure: {
        id: procedure.id,
        name: procedure.name,
        durationMinutes: procedure.durationMinutes || 30,
      },
      items: slots,
      total: slots.length,
    };
  });

  app.post('/:id/exam-orders', {
    schema: {
      summary: 'Create structured exam order from consultation',
      tags: ['Consultations'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        properties: {
          procedureId: { type: 'string' },
          examType: { type: 'string' },
          priority: { type: 'string' },
          notes: { type: 'string' },
          preferredDate: { type: 'string' },
          preferredTime: { type: 'string' },
          scheduleDate: { type: 'string' },
          scheduleTime: { type: 'string' },
          scheduleRoomId: { type: 'string' },
          scheduleMedicalEquipmentId: { type: 'string' },
        },
      },
      response: {
        201: { type: 'object' },
        400: { type: 'object', additionalProperties: true },
        403: { type: 'object', additionalProperties: true },
        409: { type: 'object', additionalProperties: true },
        404: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const data = request.body as any;

    const procedureId = String(data?.procedureId || '').trim();
    const settings = await getExamOrderBranchSettings(branchId);

    const consultation = await prisma.consultation.findFirst({
      where: {
        id,
        branchId,
        isActive: true,
        ...((context?.doctorId || context?.doctorName)
          ? {
              OR: [
                ...(context?.doctorId ? [{ doctorId: context.doctorId }] : []),
                ...(context?.doctorName ? [{ doctorName: context.doctorName }] : []),
              ],
            }
          : {}),
      },
      include: {
        appointment: true,
      },
    });
    if (!consultation) return reply.code(404).send({ error: 'Consultation not found' });

    let procedure = null as any;
    if (procedureId) {
      procedure = await prisma.procedure.findFirst({
        where: {
          id: procedureId,
          branchId,
          isActive: true,
          appointmentType: { in: ['EXAME', 'EXAM'] },
        },
        select: { id: true, name: true, durationMinutes: true },
      });
      if (!procedure) return reply.code(404).send({ error: 'Procedure not found' });
    }

    const examType = String(procedure?.name || data?.examType || '').trim();
    if (!examType) return reply.code(400).send({ error: 'procedureId or examType is required' });

    const requestedScheduleDate = String(data?.scheduleDate || '').trim();
    const requestedScheduleTime = String(data?.scheduleTime || '').trim();
    const requestedScheduleRoomId = String(data?.scheduleRoomId || '').trim();
    const requestedScheduleMedicalEquipmentId = String(data?.scheduleMedicalEquipmentId || '').trim();
    const hasRequestedScheduling = Boolean(requestedScheduleDate && requestedScheduleTime);
    if (hasRequestedScheduling && !settings.doctorCanScheduleExamFromConsultation) {
      return reply.code(403).send({ error: 'Doctor scheduling from consultation is disabled for this branch' });
    }

    const sourceAppointment = consultation.appointmentId
      ? await prisma.appointment.findFirst({
          where: { id: consultation.appointmentId, branchId, isActive: true },
        })
      : null;

    const resolvedDate = hasRequestedScheduling
      ? requestedScheduleDate
      : (data?.preferredDate ? String(data.preferredDate).trim() : null);
    const resolvedTime = hasRequestedScheduling
      ? requestedScheduleTime
      : (data?.preferredTime ? String(data.preferredTime).trim() : null);

    if (hasRequestedScheduling && !/^\d{4}-\d{2}-\d{2}$/.test(requestedScheduleDate)) {
      return reply.code(400).send({ error: 'scheduleDate must be YYYY-MM-DD' });
    }
    if (hasRequestedScheduling && !/^\d{2}:\d{2}$/.test(requestedScheduleTime)) {
      return reply.code(400).send({ error: 'scheduleTime must be HH:mm' });
    }
    if (hasRequestedScheduling && (!requestedScheduleRoomId || !requestedScheduleMedicalEquipmentId)) {
      return reply.code(400).send({ error: 'scheduleRoomId and scheduleMedicalEquipmentId are required when scheduling from consultation' });
    }

    if (hasRequestedScheduling) {
      const doctorName = String(consultation.doctorName || sourceAppointment?.doctorName || '').trim();
      const validEquipmentLink = procedure?.id
        ? await prisma.medicalEquipmentProcedure.findFirst({
            where: {
              procedureId: procedure.id,
              medicalEquipmentId: requestedScheduleMedicalEquipmentId,
              medicalEquipment: {
                branchId,
                isActive: true,
                roomId: requestedScheduleRoomId,
              },
            },
            select: { medicalEquipmentId: true },
          })
        : null;
      if (!validEquipmentLink) {
        return reply.code(400).send({ error: 'Selected room/equipment is not valid for this procedure' });
      }

      const conflicts = await prisma.appointment.findMany({
        where: {
          branchId,
          date: requestedScheduleDate,
          isActive: true,
          OR: [
            { doctorName: { equals: doctorName, mode: 'insensitive' } },
            { roomId: requestedScheduleRoomId },
            { medicalEquipmentId: requestedScheduleMedicalEquipmentId },
          ],
        },
        select: { id: true, time: true, durationMinutes: true, status: true, doctorName: true, roomId: true, medicalEquipmentId: true },
      });
      const duration = Number(procedure?.durationMinutes || 30);
      const blocking = conflicts.filter((item: any) => !NON_BLOCKING_APPOINTMENT_STATUSES.has(normalizeStatusKey(item?.status || '')));

      const doctorConflict = blocking
        .filter((item: any) => String(item?.doctorName || '').trim().toLowerCase() === doctorName.toLowerCase())
        .some((item: any) => rangesOverlap(requestedScheduleTime, duration, item?.time, item?.durationMinutes));
      if (doctorConflict) {
        return reply.code(409).send({ error: 'Scheduling conflict: doctor is busy on selected slot' });
      }

      const roomConflict = blocking
        .filter((item: any) => String(item?.roomId || '') === requestedScheduleRoomId)
        .some((item: any) => rangesOverlap(requestedScheduleTime, duration, item?.time, item?.durationMinutes));
      if (roomConflict) {
        return reply.code(409).send({ error: 'Scheduling conflict: room is busy on selected slot' });
      }

      const equipmentConflict = blocking
        .filter((item: any) => String(item?.medicalEquipmentId || '') === requestedScheduleMedicalEquipmentId)
        .some((item: any) => rangesOverlap(requestedScheduleTime, duration, item?.time, item?.durationMinutes));
      if (equipmentConflict) {
        return reply.code(409).send({ error: 'Scheduling conflict: equipment is busy on selected slot' });
      }
    }

    const normalizedPriority = data?.priority ? String(data.priority).trim().toUpperCase() : null;
    const normalizedOrderNotes = data?.notes ? String(data.notes).trim() : null;
    const normalizedPreferredDate = data?.preferredDate ? String(data.preferredDate).trim() : null;
    const normalizedPreferredTime = data?.preferredTime ? String(data.preferredTime).trim() : null;
    const normalizedProcedureId = procedureId || null;

    const created = await prisma.appointment.create({
      data: {
        branchId,
        sourceConsultationId: consultation.id,
        sourceProcedureId: normalizedProcedureId,
        patientName: sourceAppointment?.patientName || consultation.patientName || null,
        patientCpf: sourceAppointment?.patientCpf || null,
        patientId: sourceAppointment?.patientId || null,
        doctorName: consultation.doctorName || sourceAppointment?.doctorName || null,
        specialty: examType,
        durationMinutes: Number(procedure?.durationMinutes || 30),
        convenio: sourceAppointment?.convenio || consultation.convenio || null,
        date: hasRequestedScheduling ? resolvedDate : null,
        time: hasRequestedScheduling ? resolvedTime : null,
        type: 'EXAME',
        status: hasRequestedScheduling ? 'AGENDADO' : 'PEDIDO_MEDICO',
        orderPriority: normalizedPriority,
        orderNotes: normalizedOrderNotes,
        preferredDate: normalizedPreferredDate,
        preferredTime: normalizedPreferredTime,
        orderedAt: new Date(),
        requestedByDoctor: true,
        scheduledByDoctor: hasRequestedScheduling,
        roomId: hasRequestedScheduling ? requestedScheduleRoomId : null,
        medicalEquipmentId: hasRequestedScheduling ? requestedScheduleMedicalEquipmentId : null,
        observations: normalizedOrderNotes,
      },
    });

    return reply.code(201).send({
      message: hasRequestedScheduling ? 'Exam scheduled from consultation' : 'Exam order created',
      appointment: created,
    });
  });

  app.put('/:id', {
    schema: {
      summary: 'Update consultation',
      tags: ['Consultations'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object' },
      response: {
        200: { type: 'object' },
        400: { type: 'object', additionalProperties: true },
        404: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const data = request.body as any;
    const userId = String((request.user as any)?.id || '');

    try {
      const existing = await prisma.consultation.findFirst({
        where: {
          id,
          branchId,
          ...((context?.doctorId || context?.doctorName)
            ? {
                OR: [
                  ...(context?.doctorId ? [{ doctorId: context.doctorId }] : []),
                  ...(context?.doctorName ? [{ doctorName: context.doctorName }] : []),
                ],
              }
            : {}),
        },
        include: {
          appointment: {
            select: { observations: true },
          },
        },
      });
      if (!existing) return reply.code(404).send({ error: 'Consultation not found' });

      const hasQueueStatusChange = typeof data.queue === 'string' && data.queue.trim().length > 0;
      const fromStatus = canonicalClinicalQueueStatus(existing.queue);
      const toStatus = canonicalClinicalQueueStatus(data.queue);
      const isTeleconsultation = isTeleconsultationAppointment(existing.appointment);
      const allowDirectTeleconsultationStart = isTeleconsultation
        && fromStatus === 'AGUARDANDO_ATENDIMENTO'
        && toStatus === 'EM_ATENDIMENTO';
      const allowDirectTeleconsultationFinish = isTeleconsultation
        && fromStatus === 'AGUARDANDO_ATENDIMENTO'
        && toStatus === 'ATENDIMENTO_CONCLUIDO';

      if (
        hasQueueStatusChange
        && !allowDirectTeleconsultationStart
        && !allowDirectTeleconsultationFinish
        && !canTransitionClinicalQueue(existing.queue, data.queue)
      ) {
        return reply.code(400).send({
          error: 'Invalid status transition',
          message: `Não é permitido mudar de "${existing.queue || 'SEM_STATUS'}" para "${data.queue}".`,
        });
      }

      if (hasQueueStatusChange && toStatus === 'EXAME_CONCLUIDO') {
        let appointmentForExamCompletion = null as any;
        const deterministicAppointmentId = String(data?.appointmentId || existing.appointmentId || '').trim();
        if (deterministicAppointmentId) {
          appointmentForExamCompletion = await prisma.appointment.findFirst({
            where: {
              id: deterministicAppointmentId,
              branchId,
              isActive: true,
            },
          });
        }

        if (!appointmentForExamCompletion) {
          appointmentForExamCompletion = await findTodayAppointmentCandidate({
            branchId,
            patientName: existing.patientName,
            doctorName: existing.doctorName,
            agenda: existing.agenda || existing.scheduledFor,
          });
        }

        if (!appointmentForExamCompletion?.id) {
          return reply.code(400).send({
            error: 'Exam completion blocked',
            message: 'Não foi possível identificar o agendamento do exame para validar as imagens recebidas.',
          });
        }

        const hasImage = await prisma.reportWorklistItem.findFirst({
          where: {
            appointmentId: appointmentForExamCompletion.id,
            isActive: true,
            AND: [
              { OR: [{ branchId }, { branchId: null }] },
              { OR: [
              { dicomReceivedAt: { not: null } },
              { dicomStudyUid: { not: null } },
              { dicomUrl: { not: null } },
              { dicomFiles: { some: {} } },
              ] },
            ],
          },
          select: { id: true },
        });

        if (!hasImage) {
          return reply.code(400).send({
            error: 'Exam completion blocked',
            message: 'Não é permitido finalizar exame sem imagem recebida no sistema.',
          });
        }
      }

      const nextData = {
        ...data,
        branchId,
        ...(hasQueueStatusChange
          ? { triageNotes: appendQueueStatusAudit(data.triageNotes ?? existing.triageNotes, existing.queue, data.queue, userId || null) }
          : {}),
      };

      const item = await prisma.consultation.update({ where: { id }, data: nextData });

      const movedToInProgress = hasQueueStatusChange
        && canonicalClinicalQueueStatus(data.queue) === 'EM_ATENDIMENTO';
      const movedToDone = hasQueueStatusChange
        && ['ATENDIMENTO_CONCLUIDO', 'EXAME_CONCLUIDO'].includes(canonicalClinicalQueueStatus(data.queue));

      if (movedToInProgress || movedToDone) {
        const finalStatusKey = canonicalClinicalQueueStatus(data.queue);
        const isExamCompletion = finalStatusKey === 'EXAME_CONCLUIDO';
        let appointment = null as any;

        try {
          const deterministicAppointmentId = String(data?.appointmentId || existing.appointmentId || item.appointmentId || '').trim();

          if (deterministicAppointmentId) {
            appointment = await prisma.appointment.findFirst({
              where: {
                id: deterministicAppointmentId,
                branchId,
                isActive: true,
              },
            });
          }

          if (!appointment) {
            appointment = await findTodayAppointmentCandidate({
              branchId,
              patientName: existing.patientName || item.patientName,
              doctorName: existing.doctorName || item.doctorName,
              agenda: existing.agenda || item.agenda || existing.scheduledFor || item.scheduledFor,
            });
          }

          if (appointment) {
            const actorUserId = String((request.user as any)?.id || '').trim() || null;
            await prisma.$transaction(async (tx: any) => {
              const current = await tx.appointment.findUnique({ where: { id: appointment.id } });
              if (!current) return;

              if (movedToInProgress) {
                const currentStatus = normalizeStatusKey(current.status || '');
                if (currentStatus !== 'EM_ANDAMENTO' && currentStatus !== 'IN_PROGRESS') {
                  const existingObservation = String(current.observations || '').trim();
                  const note = `[clinical-start] ${new Date().toISOString()} consultation:${item.id}`;
                  await tx.appointment.update({
                    where: { id: current.id },
                    data: {
                      status: 'EM ANDAMENTO',
                      observations: [existingObservation, note].filter(Boolean).join('\n'),
                    },
                  });
                }
                return;
              }

              const appointmentStatusKey = normalizeStatusKey(current.status || '');
              if (appointmentStatusKey !== 'REALIZADO') {
                const existingObservation = String(current.observations || '').trim();
                const note = `[clinical-finish] ${new Date().toISOString()} consultation:${item.id}`;
                const updateData: any = {
                  status: 'REALIZADO',
                  observations: [existingObservation, note].filter(Boolean).join('\n'),
                  inventoryReservedAt: null,
                  inventoryReservationSnapshot: null,
                  inventoryReservationSource: null,
                };

                if (!current.inventoryConsumedAt) {
                  const consumedSnapshot = await applyProcedureMaterialStock(
                    tx,
                    current,
                    'consume',
                    null,
                    { actorUserId, appointmentId: current.id },
                  );
                  updateData.inventoryConsumedAt = new Date();
                  updateData.inventoryConsumptionSnapshot = consumedSnapshot as any;
                  updateData.inventoryConsumptionSource = consumedSnapshot?.source || null;
                }

                await tx.appointment.update({
                  where: { id: current.id },
                  data: updateData,
                });
              }
            });
          }

          if (movedToDone) {
            try {
              await ensureInvoiceForCompletedAppointment({
                branchId,
                consultation: item,
                appointment,
                isExam: isExamCompletion,
              });
            } catch (invoiceErr: any) {
              request.log.warn({ err: invoiceErr, consultationId: item.id, appointmentId: appointment?.id || null }, 'Could not create billing invoice for completed appointment');
            }
          }
        } catch (appointmentErr: any) {
          request.log.warn({ err: appointmentErr, consultationId: item.id }, movedToDone
            ? 'Could not sync appointment completion'
            : 'Could not sync appointment start');
        }
      }

      return item;
    } catch (err: any) {
      request.log.error({ err }, 'Failed to update consultation');
      return reply.code(400).send({ error: 'Failed to update consultation', details: err.message });
    }
  });

  app.delete('/:id', {
    schema: {
      summary: 'Delete consultation',
      tags: ['Consultations'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const existing = await prisma.consultation.findFirst({
      where: {
        id,
        branchId,
        ...((context?.doctorId || context?.doctorName)
          ? {
              OR: [
                ...(context?.doctorId ? [{ doctorId: context.doctorId }] : []),
                ...(context?.doctorName ? [{ doctorName: context.doctorName }] : []),
              ],
            }
          : {}),
      },
    });
    if (!existing) return reply.code(404).send({ error: 'Consultation not found' });
    await prisma.consultation.delete({ where: { id } });
    return { message: 'Deleted' };
  });
}
