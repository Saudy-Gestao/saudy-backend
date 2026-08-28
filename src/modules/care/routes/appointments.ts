import { randomBytes } from 'crypto';
import { FastifyInstance } from 'fastify';
import { Storage } from '@google-cloud/storage';
import prisma from '../lib/prisma';
import type { Prisma } from '@prisma/client';
import { publishAppointmentCreatedEvent, publishAppointmentNoShowEventIfNeeded } from '../lib/appointment-whatsapp-events';

const COMPLETED_STATUSES = new Set(['REALIZADO', 'COMPLETED', 'FINALIZADO', 'ATENDIDO']);
const CANCELED_STATUSES = new Set(['CANCELADO', 'CANCELED']);
const NO_SHOW_STATUSES = new Set(['NAO_COMPARECEU', 'NÃƒO_COMPARECEU', 'NO_SHOW', 'NO-SHOW', 'AUSENTE', 'FALTOU']);
const RESERVABLE_STATUSES = new Set(['AGENDADO', 'SCHEDULED', 'CONFIRMADO', 'CONFIRMED', 'EM ANDAMENTO', 'EM_ANDAMENTO', 'IN_PROGRESS']);

const normalizeStatus = (status?: string | null) => String(status || '').trim().toUpperCase();

const normalizeAppointmentType = (value?: string | null): 'CONSULTA' | 'EXAME' | null => {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return null;
  if (normalized === 'EXAME' || normalized === 'EXAM') return 'EXAME';
  if (normalized === 'CONSULTA' || normalized === 'CONSULTATION' || normalized === 'CONSULTA_CLINICA' || normalized === 'CONSULTA_TERAPIAS') return 'CONSULTA';
  return null;
};

const parseProcedureNamesFromSpecialty = (value?: string | null): string[] => (
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
);

const hasMixedAppointmentTypeInSpecialty = async (params: {
  branchId: string;
  specialty?: string | null;
}) => {
  const names = parseProcedureNamesFromSpecialty(params.specialty);
  if (names.length <= 1) return false;

  const procedures = await prisma.procedure.findMany({
    where: {
      branchId: params.branchId,
      isActive: true,
      OR: names.map((name) => ({ name: { equals: name, mode: 'insensitive' as const } })),
    },
    select: {
      name: true,
      appointmentType: true,
    },
    take: Math.max(20, names.length * 2),
  });

  if (!procedures.length) return false;

  const normalizedProcedureNames = new Set(names.map((name) => name.toLowerCase()));
  const typeSet = new Set<'CONSULTA' | 'EXAME'>();
  for (const procedure of procedures) {
    const procedureName = String(procedure?.name || '').trim().toLowerCase();
    if (!procedureName || !normalizedProcedureNames.has(procedureName)) continue;
    const procedureType = normalizeAppointmentType(procedure?.appointmentType);
    if (procedureType) typeSet.add(procedureType);
  }

  return typeSet.size > 1;
};

const mapAppointmentStatusToWorklistStatus = (status?: string | null) => {
  const normalized = normalizeStatus(status);
  if (CANCELED_STATUSES.has(normalized)) return 'cancelado';
  if (NO_SHOW_STATUSES.has(normalized)) return 'cancelado';
  if (COMPLETED_STATUSES.has(normalized)) return 'finalizado';
  if (normalized === 'CONFIRMED' || normalized === 'CONFIRMADO') return 'confirmado';
  if (normalized === 'EM ANDAMENTO' || normalized === 'EM_ANDAMENTO' || normalized === 'IN_PROGRESS') return 'em_andamento';
  return 'agendado';
};

const isConfirmedAppointmentStatus = (status?: string | null) => {
  const normalized = normalizeStatus(status);
  return normalized.startsWith('CONFIRM');
};

const markManualConfirmationAsResolved = async (tx: Prisma.TransactionClient, params: {
  branchId: string;
  appointmentId: string;
  patientName?: string | null;
}) => {
  const { branchId, appointmentId, patientName } = params;

  const updatedPendingLogs = await tx.whatsAppMessageLog.updateMany({
    where: {
      branchId,
      appointmentId,
      messageType: 'APPOINTMENT_CONFIRMATION',
      status: { in: ['PENDING', 'SENT'] },
    },
    data: {
      status: 'RESPONDED_CONFIRMED',
    },
  });

  if (updatedPendingLogs.count > 0) return;

  const existingResolvedLog = await tx.whatsAppMessageLog.findFirst({
    where: {
      branchId,
      appointmentId,
      messageType: 'APPOINTMENT_CONFIRMATION',
      NOT: {
        status: { in: ['FAILED', 'ERROR'] },
      },
    },
    select: { id: true },
  });

  if (existingResolvedLog) return;

  const now = new Date();
  await tx.whatsAppMessageLog.create({
    data: {
      branchId,
      appointmentId,
      patientName: patientName || null,
      patientPhone: 'N/A',
      messageType: 'APPOINTMENT_CONFIRMATION',
      message: 'Confirmação registrada manualmente na agenda.',
      status: 'RESPONDED_CONFIRMED',
      sentAt: now,
      deliveredAt: now,
      readAt: now,
    },
  });
};

const generateAccessionNumber = () => {
  // AcessionNumber deve ser Ãºnico para correlaÃ§Ã£o MWL/DICOM.
  // Usamos timestamp + random para evitar colisÃµes em ambiente de alta concorrÃªncia.
  return `ACC-${Date.now()}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
};

const hasAccessionNumber = (value?: string | null) => String(value || '').trim().length > 0;

const CLINIC_TIME_ZONE = process.env.APP_TIMEZONE || 'America/Sao_Paulo';
const APPOINTMENT_MUTABLE_FIELDS = new Set([
  'rescheduledFromAppointmentId',
  'sourceConsultationId',
  'sourceProcedureId',
  'patientName',
  'patientCpf',
  'patientId',
  'doctorName',
  'roomId',
  'medicalEquipmentId',
  'specialty',
  'convenio',
  'date',
  'time',
  'durationMinutes',
  'type',
  'status',
  'accessionNumber',
  'authorizationStatus',
  'authorizationNotes',
  'orderPriority',
  'orderNotes',
  'preferredDate',
  'preferredTime',
  'orderedAt',
  'requestedByDoctor',
  'scheduledByDoctor',
  'observations',
  'totem',
  'isActive',
]);

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

const formatDateInTimeZone = (date: Date, timeZone = CLINIC_TIME_ZONE) => {
  const { year, month, day } = getTimeZoneParts(date, timeZone);
  return `${year}-${month}-${day}`;
};

const formatTimeInTimeZone = (date: Date, timeZone = CLINIC_TIME_ZONE) => {
  const { hour, minute } = getTimeZoneParts(date, timeZone);
  return `${hour}:${minute}`;
};

const normalizeCpf = (value?: string | null) => String(value || '').replace(/\D/g, '').trim();

const parseTimeToMinutes = (value?: string | null): number | null => {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return (hours * 60) + minutes;
};

const timeRangesOverlap = (
  startA?: string | null,
  durationA?: number | null,
  startB?: string | null,
  durationB?: number | null,
): boolean => {
  const startMinutesA = parseTimeToMinutes(startA);
  const startMinutesB = parseTimeToMinutes(startB);
  if (startMinutesA === null || startMinutesB === null) return false;
  const safeDurationA = Number.isFinite(durationA) && Number(durationA) > 0 ? Number(durationA) : 30;
  const safeDurationB = Number.isFinite(durationB) && Number(durationB) > 0 ? Number(durationB) : 30;
  const endMinutesA = startMinutesA + safeDurationA;
  const endMinutesB = startMinutesB + safeDurationB;
  return startMinutesA < endMinutesB && startMinutesB < endMinutesA;
};

const hasBlockingStatus = (status?: string | null) => {
  const normalized = normalizeStatus(status);
  return !(CANCELED_STATUSES.has(normalized) || COMPLETED_STATUSES.has(normalized) || NO_SHOW_STATUSES.has(normalized));
};

const isNoShowAppointmentStatus = (status?: string | null) => {
  const normalized = normalizeStatus(status);
  return NO_SHOW_STATUSES.has(normalized);
};

async function findDoctorScheduleConflict(params: {
  tx: Prisma.TransactionClient;
  branchId: string;
  doctorName?: string | null;
  date?: string | null;
  time?: string | null;
  durationMinutes?: number | null;
  excludeAppointmentId?: string | null;
}) {
  const { tx, branchId, doctorName, date, time, durationMinutes, excludeAppointmentId } = params;
  if (!doctorName || !date || !time) return null;

  const candidates = await tx.appointment.findMany({
    where: {
      branchId,
      doctorName,
      date,
      isActive: true,
      ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
      NOT: [
        { status: 'CANCELED' },
        { status: 'CANCELADO' },
        { status: 'COMPLETED' },
        { status: 'CONCLUIDO' },
        { status: 'NAO_COMPARECEU' },
        { status: 'NÃO_COMPARECEU' },
        { status: 'NO_SHOW' },
        { status: 'NO-SHOW' },
        { status: 'AUSENTE' },
        { status: 'FALTOU' },
      ],
    },
    select: {
      id: true,
      patientName: true,
      time: true,
      durationMinutes: true,
      status: true,
    },
  });

  return candidates.find((candidate: any) => (
    timeRangesOverlap(time, durationMinutes, candidate?.time, candidate?.durationMinutes)
  )) || null;
}

async function findResourceScheduleConflict(params: {
  tx: Prisma.TransactionClient;
  branchId: string;
  roomId?: string | null;
  medicalEquipmentId?: string | null;
  date?: string | null;
  time?: string | null;
  durationMinutes?: number | null;
  excludeAppointmentId?: string | null;
}) {
  const { tx, branchId, roomId, medicalEquipmentId, date, time, durationMinutes, excludeAppointmentId } = params;
  if ((!roomId && !medicalEquipmentId) || !date || !time) return null;

  const candidates = await tx.appointment.findMany({
    where: {
      branchId,
      date,
      isActive: true,
      ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
      OR: [
        ...(roomId ? [{ roomId }] : []),
        ...(medicalEquipmentId ? [{ medicalEquipmentId }] : []),
      ],
      NOT: [
        { status: 'CANCELED' },
        { status: 'CANCELADO' },
        { status: 'COMPLETED' },
        { status: 'CONCLUIDO' },
        { status: 'NAO_COMPARECEU' },
        { status: 'NÃO_COMPARECEU' },
        { status: 'NO_SHOW' },
        { status: 'NO-SHOW' },
        { status: 'AUSENTE' },
        { status: 'FALTOU' },
      ],
    },
    select: {
      id: true,
      roomId: true,
      medicalEquipmentId: true,
      time: true,
      durationMinutes: true,
      status: true,
    },
  });

  return candidates.find((candidate: any) => (
    timeRangesOverlap(time, durationMinutes, candidate?.time, candidate?.durationMinutes)
  )) || null;
}

const minutesToTimeString = (value: number): string | null => {
  if (!Number.isFinite(value)) return null;
  const safe = Math.max(0, Math.min(1439, Math.floor(value)));
  const hour = String(Math.floor(safe / 60)).padStart(2, '0');
  const minute = String(safe % 60).padStart(2, '0');
  return `${hour}:${minute}`;
};

async function findPatientScheduleConflict(params: {
  tx: Prisma.TransactionClient;
  branchId: string;
  patientId?: string | null;
  patientCpf?: string | null;
  date?: string | null;
  time?: string | null;
  durationMinutes?: number | null;
  excludeAppointmentId?: string | null;
}) {
  const {
    tx,
    branchId,
    patientId,
    patientCpf,
    date,
    time,
    durationMinutes,
    excludeAppointmentId,
  } = params;

  if (!date || !time) return null;

  const normalizedPatientId = String(patientId || '').trim();
  const normalizedPatientCpf = normalizeCpf(patientCpf);
  if (!normalizedPatientId && !normalizedPatientCpf) return null;

  const candidates = await tx.appointment.findMany({
    where: {
      branchId,
      date,
      isActive: true,
      ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
      OR: [
        ...(normalizedPatientId ? [{ patientId: normalizedPatientId }] : []),
        ...(normalizedPatientCpf ? [{ patientCpf: { contains: normalizedPatientCpf } }] : []),
      ],
      NOT: [
        { status: 'CANCELED' },
        { status: 'CANCELADO' },
        { status: 'COMPLETED' },
        { status: 'CONCLUIDO' },
        { status: 'NAO_COMPARECEU' },
        { status: 'NÃO_COMPARECEU' },
        { status: 'NO_SHOW' },
        { status: 'NO-SHOW' },
        { status: 'AUSENTE' },
        { status: 'FALTOU' },
      ],
    },
    select: {
      id: true,
      patientName: true,
      time: true,
      durationMinutes: true,
      type: true,
      specialty: true,
      status: true,
    },
  });

  const conflict = candidates.find((candidate: any) => (
    timeRangesOverlap(time, durationMinutes, candidate?.time, candidate?.durationMinutes)
  )) || null;

  if (!conflict) return null;

  const conflictStartMinutes = parseTimeToMinutes(conflict?.time);
  const conflictDuration = Number.isFinite(Number(conflict?.durationMinutes)) && Number(conflict?.durationMinutes) > 0
    ? Number(conflict.durationMinutes)
    : 30;
  const suggestedTime = conflictStartMinutes === null
    ? null
    : minutesToTimeString(conflictStartMinutes + conflictDuration);

  return {
    ...conflict,
    suggestedTime,
  };
}

const GCS_BUCKET = process.env.GOOGLE_STORAGE_BUCKET_ANEXOS
  || process.env.GOOGLE_STORAGE_BUCKET_CONVENIO_AUTH
  || process.env.GOOGLE_STORAGE_BUCKET;
const storage = GCS_BUCKET ? new Storage() : null;
const bucket = (storage && GCS_BUCKET) ? storage.bucket(GCS_BUCKET) : null;

const sanitizeFileName = (value: string) => String(value || 'arquivo')
  .replace(/[^a-zA-Z0-9._-]/g, '_')
  .replace(/_+/g, '_')
  .slice(0, 120);

const decodeBase64 = (raw: string): Buffer => {
  const trimmed = String(raw || '').trim();
  const normalized = trimmed.includes(',') ? trimmed.split(',').pop() || '' : trimmed;
  return Buffer.from(normalized, 'base64');
};

const makeObjectSuffix = () => randomBytes(8).toString('hex');

const applyAutomaticNoShowForBranch = async (branchId: string) => {
  const settings = await prisma.branchSettings.findUnique({ where: { branchId } });
  const toleranceMinutes = Math.max(0, Number(settings?.noShowToleranceMinutes ?? 30));
  const threshold = new Date(Date.now() - (toleranceMinutes * 60 * 1000));
  const thresholdDate = formatDateInTimeZone(threshold);
  const thresholdTime = formatTimeInTimeZone(threshold);

  const candidates = await prisma.appointment.findMany({
    where: {
      branchId,
      isActive: true,
      status: { in: ['AGENDADO', 'CONFIRMADO'] },
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

  const appointmentIds = candidates.map((item: { id: string }) => item.id);

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.appointment.updateMany({
      where: { id: { in: appointmentIds } },
      data: { status: 'NAO_COMPARECEU' },
    });

    await tx.mwlEntry.updateMany({
      where: { appointmentId: { in: appointmentIds } },
      data: { status: 'cancelado', isActive: false },
    });
  });

  for (const appointmentId of appointmentIds) {
    publishAppointmentNoShowEventIfNeeded({ branchId, appointmentId });
  }
};

// Creates or updates the MwlEntry linked to this appointment.
// MwlEntry is what the imaging equipment queries via MWL/C-FIND.
// It is NOT the DICOM index â€” that is ReportWorklistItem, created later when the image arrives.
const syncMwlFromAppointment = async (
  tx: Prisma.TransactionClient,
  appointment: any,
  branchId: string,
) => {
  const existing = await tx.mwlEntry.findFirst({
    where: {
      appointmentId: appointment.id,
      OR: [{ branchId }, { branchId: null }],
    },
  });

  const scheduledAt = appointment.date
    ? appointment.time
      ? `${appointment.date} ${appointment.time}`
      : String(appointment.date)
    : null;

  const payload = {
    branchId,
    appointmentId: appointment.id,
    accessionNumber: appointment.accessionNumber || null,
    patientName: appointment.patientName || null,
    patientCpf: appointment.patientCpf || null,
    examType: appointment.specialty || null,
    scheduledAt,
    convenio: appointment.convenio || null,
    requestingDoctor: appointment.doctorName || null,
    status: mapAppointmentStatusToWorklistStatus(appointment.status),
  };

  if (existing) {
    await tx.mwlEntry.update({ where: { id: existing.id }, data: payload });
    return;
  }

  // Business rule: create MWL entry only after exam/appointment is confirmed.
  if (!isConfirmedAppointmentStatus(appointment.status)) {
    return;
  }

  await tx.mwlEntry.create({ data: payload });
};

const recomputeInventoryItemStatus = async (tx: Prisma.TransactionClient, inventoryItemId: string) => {
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

const normalizeKitKey = (value?: string | null) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

const resolveProcedureMaterialRequirements = async (
  tx: Prisma.TransactionClient,
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

type InventoryConsumptionSnapshot = {
  source: string;
  materials: Array<{
    inventoryItemId: string;
    quantity: number;
    consumedLots?: Array<{ lotId: string; lotCode?: string | null; quantity: number }>;
  }>;
};

type InventoryReservationSnapshot = {
  source: string;
  materials: Array<{ inventoryItemId: string; quantity: number }>;
};

const reserveProcedureMaterialsSnapshot = async (
  tx: Prisma.TransactionClient,
  appointment: { branchId?: string | null; specialty?: string | null; convenio?: string | null },
) => {
  const resolved = await resolveProcedureMaterialRequirements(tx, appointment);
  const materials = Array.isArray(resolved.materials) ? resolved.materials : [];
  if (!materials.length) return null;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  for (const material of materials) {
    const item = await tx.inventoryItem.findUnique({ where: { id: material.inventoryItemId } });
    if (!item) {
      throw new Error(`Material não encontrado: ${material.inventoryItemId}`);
    }

    const lots = await tx.inventoryLot.findMany({
      where: {
        inventoryItemId: material.inventoryItemId,
        quantity: { gt: 0 },
        OR: [
          { expiryDate: null },
          { expiryDate: { gte: todayStart } },
        ],
      },
      select: { quantity: true },
    });

    const availableFromLots = lots.reduce((sum: number, lot: any) => sum + Number(lot.quantity || 0), 0);
    const available = lots.length > 0 ? availableFromLots : Number(item.quantity || 0);
    if (available < material.quantity) {
      const itemName = item.name || material.inventoryItemId;
      throw new Error(`Estoque insuficiente para reservar material "${itemName}".`);
    }
  }

  return {
    source: resolved.source,
    materials: materials.map((material) => ({
      inventoryItemId: material.inventoryItemId,
      quantity: material.quantity,
    })),
  } satisfies InventoryReservationSnapshot;
};

const consumeLotsByFefo = async (
  tx: Prisma.TransactionClient,
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

const applyProcedureMaterialStock = async (
  tx: Prisma.TransactionClient,
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
    : { source: snapshot?.source || 'UNKNOWN', materials: Array.isArray(snapshot?.materials) ? snapshot!.materials : [] };
  const materials = Array.isArray(resolved.materials) ? resolved.materials : [];
  if (!materials.length) return null;

  if (mode === 'consume') {
    const snapshotMaterials: InventoryConsumptionSnapshot['materials'] = [];

    for (const material of materials) {
      const before = await tx.inventoryItem.findUnique({ where: { id: material.inventoryItemId } });
      if (!before) {
        throw new Error(`Material não encontrado: ${material.inventoryItemId}`);
      }

      const fefo = await consumeLotsByFefo(tx, material.inventoryItemId, material.quantity);
      if (fefo.usedLots && fefo.remaining > 0) {
        const itemName = before?.name || material.inventoryItemId;
        throw new Error(`Estoque insuficiente em lotes válidos para material "${itemName}".`);
      }

      const updated = await tx.inventoryItem.updateMany({
        where: {
          id: material.inventoryItemId,
          quantity: { gte: material.quantity },
        },
        data: {
          quantity: { decrement: material.quantity },
        },
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

export default async function appointmentRoutes(app: FastifyInstance) {
  const getLoggedBranchId = async (request: any) => {
    const userId = (request.user as any)?.id;
    if (!userId) return null;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });
    return user?.sector?.branch?.id || null;
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
      summary: 'List appointments',
      tags: ['Appointments'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          status: { type: 'string' },
          authorizationStatus: { type: 'string' },
          specialty: { type: 'string' },
          convenio: { type: 'string' },
          patientId: { type: 'string' },
          patientCpf: { type: 'string' },
          date: { type: 'string' }, // YYYY-MM-DD
          startDate: { type: 'string' }, // YYYY-MM-DD
          endDate: { type: 'string' }, // YYYY-MM-DD
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return { items: [], total: 0 };

    await applyAutomaticNoShowForBranch(branchId);

    const { 
      search, 
      status, 
      authorizationStatus, 
      specialty, 
      convenio,
      patientId,
      patientCpf,
      date,
      startDate,
      endDate,
      limit = 50, 
      offset = 0 
    } = request.query as any;

    const branchPatients = await prisma.patient.findMany({
      where: { branchId },
      select: { id: true },
      take: 10000,
    });
    const branchPatientIds = branchPatients
      .map((item: any) => String(item?.id || '').trim())
      .filter(Boolean);

    const branchScope = {
      OR: [
        { branchId },
        ...(branchPatientIds.length > 0
          ? [{ branchId: null, patientId: { in: branchPatientIds } }]
          : []),
      ],
    };

    const where: any = {
      isActive: true,
      AND: [branchScope],
    };
    if (status) where.status = status;
    if (authorizationStatus) where.authorizationStatus = authorizationStatus;
    if (specialty) where.specialty = specialty;
    if (convenio) where.convenio = convenio;
    
    // Filtro por paciente
    if (patientId) where.patientId = patientId;
    if (patientCpf) {
      const normalizedCpf = patientCpf.replace(/\D/g, '');
      where.patientCpf = { contains: normalizedCpf };
    }
    
    // Filtro por data
    if (date) {
      where.date = date;
    } else if (startDate || endDate) {
      where.date = {};
      if (startDate) where.date.gte = startDate;
      if (endDate) where.date.lte = endDate;
    }
    
    // Search (sÃ³ aplica se nÃ£o tiver filtros especÃ­ficos de paciente)
    if (search && !patientId && !patientCpf) {
      where.AND.push({
        OR: [
          { patientName: { contains: search, mode: 'insensitive' } },
          { patientCpf: { contains: search, mode: 'insensitive' } },
          { doctorName: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    const [items, total] = await Promise.all([
      prisma.appointment.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: [
          { date: 'asc' },
          { time: 'asc' },
        ]
      }),
      prisma.appointment.count({ where }),
    ]);

    return { items, total };
  });

  app.get('/:id', {
    schema: {
      summary: 'Get appointment by ID',
      tags: ['Appointments'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const item = await prisma.appointment.findFirst({ where: { id, branchId } });
    if (!item) return reply.code(404).send({ error: 'Appointment not found' });
    return item;
  });

  app.get('/:id/attachments', {
    schema: {
      summary: 'List appointment attachments',
      tags: ['Appointments'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const appointment = await prisma.appointment.findFirst({
      where: { id, branchId, isActive: true },
      select: { id: true },
    });
    if (!appointment) return reply.code(404).send({ error: 'Appointment not found' });

    const items = await prisma.appointmentAttachment.findMany({
      where: { appointmentId: id, branchId, isActive: true },
      orderBy: { uploadedAt: 'desc' },
    });

    return {
      total: items.length,
      items: items.map((item: any) => ({
        id: item.id,
        fileName: item.fileName,
        mimeType: item.mimeType || null,
        sizeBytes: item.sizeBytes || null,
        uploadedAt: item.uploadedAt,
      })),
    };
  });

  app.get('/attachments/:attachmentId/view', {
    schema: {
      summary: 'View appointment attachment',
      tags: ['Appointments'],
      params: {
        type: 'object',
        properties: { attachmentId: { type: 'string' } },
        required: ['attachmentId'],
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { attachmentId } = request.params as any;
    const attachment = await prisma.appointmentAttachment.findFirst({
      where: { id: attachmentId, branchId, isActive: true },
    });
    if (!attachment) return reply.code(404).send({ error: 'Attachment not found' });
    if (!bucket) return reply.code(503).send({ error: 'Bucket GCS nao configurado (GOOGLE_STORAGE_BUCKET_ANEXOS)' });

    const file = bucket.file(attachment.gcsObjectName);
    const [exists] = await file.exists();
    if (!exists) return reply.code(404).send({ error: 'Arquivo nao encontrado no storage' });

    reply.header('Content-Type', attachment.mimeType || 'application/octet-stream');
    reply.header('Content-Disposition', `inline; filename="${attachment.fileName || 'anexo'}"`);
    return reply.send(file.createReadStream());
  });

  app.post('/:id/attachments', {
    schema: {
      summary: 'Upload attachment for appointment',
      tags: ['Appointments'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        required: ['fileName', 'fileBase64'],
        properties: {
          fileName: { type: 'string' },
          fileBase64: { type: 'string' },
          mimeType: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });
    if (!bucket) return reply.code(503).send({ error: 'Bucket GCS nao configurado (GOOGLE_STORAGE_BUCKET_ANEXOS)' });

    const userId = String((request.user as any)?.id || '');
    const { id } = request.params as any;
    const payload = request.body as { fileName: string; fileBase64: string; mimeType?: string };

    const appointment = await prisma.appointment.findFirst({
      where: { id, branchId, isActive: true },
      select: { id: true },
    });
    if (!appointment) return reply.code(404).send({ error: 'Appointment not found' });

    const safeFileName = sanitizeFileName(payload.fileName || 'anexo');
    const buffer = decodeBase64(payload.fileBase64);
    if (!buffer || buffer.length === 0) {
      return reply.code(400).send({ error: 'Arquivo invalido' });
    }

    const objectName = `scheduling/${branchId}/${id}/${Date.now()}_${makeObjectSuffix()}_${safeFileName}`;
    const file = bucket.file(objectName);
    await file.save(buffer, {
      resumable: false,
      contentType: payload.mimeType || 'application/octet-stream',
      metadata: {
        contentType: payload.mimeType || 'application/octet-stream',
        metadata: {
          branchId,
          appointmentId: id,
          uploadedByUserId: userId || '',
        },
      },
    });

    const created = await prisma.appointmentAttachment.create({
      data: {
        branchId,
        appointmentId: id,
        fileName: safeFileName,
        mimeType: payload.mimeType || null,
        sizeBytes: buffer.length,
        gcsObjectName: objectName,
        uploadedByUserId: userId || null,
      },
    });

    return reply.code(201).send({
      message: 'Anexo enviado com sucesso',
      item: {
        id: created.id,
        fileName: created.fileName,
        mimeType: created.mimeType || null,
        sizeBytes: created.sizeBytes || null,
        uploadedAt: created.uploadedAt,
      },
    });
  });

  app.post('/', {
    schema: {
      summary: 'Create appointment',
      tags: ['Appointments'],
      body: {
        type: 'object',
        required: ['specialty', 'date', 'time'],
        properties: {
          patientName: { type: 'string' },
          patientCpf: { type: 'string' },
          patientId: { type: 'string' },
          doctorName: { type: 'string' },
          roomId: { type: 'string' },
          medicalEquipmentId: { type: 'string' },
          specialty: { type: 'string' },
          durationMinutes: { type: 'number' },
          convenio: { type: 'string' },
          date: { type: 'string' },
          time: { type: 'string' },
          type: { type: 'string' },
          status: { type: 'string' },
          authorizationStatus: { type: 'string' },
          authorizationNotes: { type: 'string' },
          observations: { type: 'string' },
          totem: { type: 'number' },
          accessionNumber: { type: 'string' },
          rescheduledFromAppointmentId: { type: 'string' },
        },
      },
      response: {
        201: { type: 'object' },
        400: { type: 'object', additionalProperties: true },
        409: { type: 'object', additionalProperties: true },
        403: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;
    try {
      const mixedProcedureTypes = await hasMixedAppointmentTypeInSpecialty({
        branchId,
        specialty: data?.specialty || null,
      });
      if (mixedProcedureTypes) {
        return reply.code(400).send({
          error: 'Invalid appointment mix',
          message: 'Não é permitido misturar procedimentos de consulta e exame na mesma marcação.',
        });
      }
      const normalizedType = normalizeAppointmentType(data?.type || null);
      if (
        normalizedType === 'CONSULTA'
        && String(data?.roomId || '').trim()
        && String(data?.medicalEquipmentId || '').trim()
      ) {
        return reply.code(400).send({
          error: 'Invalid appointment payload',
          message: 'Consulta não pode ser salva com sala e equipamento de exame ao mesmo tempo.',
        });
      }

      if (data.rescheduledFromAppointmentId) {
        const source = await prisma.appointment.findFirst({
          where: { id: String(data.rescheduledFromAppointmentId), branchId },
          select: { id: true },
        });
        if (!source) {
          return reply.code(400).send({ error: 'Source appointment for reschedule not found' });
        }
      }

      const requestedDurationMinutes = Number.isFinite(data.durationMinutes) ? Number(data.durationMinutes) : 30;
      const patientConflict = await prisma.$transaction(async (tx: Prisma.TransactionClient) => (
        findPatientScheduleConflict({
          tx,
          branchId,
          patientId: data.patientId || null,
          patientCpf: data.patientCpf || null,
          date: data.date || null,
          time: data.time || null,
          durationMinutes: requestedDurationMinutes,
        })
      ));

      if (patientConflict) {
        return reply.code(409).send({
          error: 'Scheduling conflict',
          conflictType: 'PATIENT',
          message: 'O paciente já possui outro agendamento nesse horário.',
          details: 'Conflito às ' + String(patientConflict.time || '') + '.'
            + (patientConflict.suggestedTime ? ` Sugestão: ${patientConflict.suggestedTime}.` : ''),
        });
      }

      const doctorConflict = await prisma.$transaction(async (tx: Prisma.TransactionClient) => (
        findDoctorScheduleConflict({
          tx,
          branchId,
          doctorName: data.doctorName || null,
          date: data.date || null,
          time: data.time || null,
          durationMinutes: requestedDurationMinutes,
        })
      ));

      if (doctorConflict) {
        return reply.code(409).send({
          error: 'Scheduling conflict',
          conflictType: 'DOCTOR',
          message: 'O médico já possui outra consulta nesse horário.',
          details: 'Conflito com ' + String(doctorConflict.patientName || 'outro paciente') + ' às ' + String(doctorConflict.time || '') + '.',
        });
      }

      const resourceConflict = await prisma.$transaction(async (tx: Prisma.TransactionClient) => (
        findResourceScheduleConflict({
          tx,
          branchId,
          roomId: data.roomId || null,
          medicalEquipmentId: data.medicalEquipmentId || null,
          date: data.date || null,
          time: data.time || null,
          durationMinutes: requestedDurationMinutes,
        })
      ));

      if (resourceConflict) {
        return reply.code(409).send({
          error: 'Scheduling conflict',
          conflictType: 'RESOURCE',
          message: 'A sala ou o equipamento já está reservado nesse horário.',
          details: 'Conflito identificado no recurso selecionado.',
        });
      }

      const item = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const created = await tx.appointment.create({ data: {
          branchId,
          rescheduledFromAppointmentId: data.rescheduledFromAppointmentId || null,
          patientName: data.patientName || null,
          patientCpf: data.patientCpf || null,
          patientId: data.patientId || null,
          doctorName: data.doctorName || null,
          roomId: data.roomId || null,
          medicalEquipmentId: data.medicalEquipmentId || null,
          specialty: data.specialty || null,
          durationMinutes: Number.isFinite(data.durationMinutes) ? Number(data.durationMinutes) : null,
          convenio: data.convenio || null,
          date: data.date || null,
          time: data.time || null,
          type: data.type || null,
          status: data.status || null,
          accessionNumber: data.accessionNumber && String(data.accessionNumber).trim().length > 0
            ? String(data.accessionNumber).trim()
            : generateAccessionNumber(),
          authorizationStatus: data.authorizationStatus || 'PENDING',
          authorizationNotes: data.authorizationNotes || null,
          authorizedAt: data.authorizationStatus === 'AUTHORIZED' ? new Date() : null,
          observations: data.observations || null,
          totem: data.totem ?? null,
        } });

        const createdStatus = normalizeStatus(created.status);
        if (RESERVABLE_STATUSES.has(createdStatus)) {
          const reservationSnapshot = await reserveProcedureMaterialsSnapshot(tx, created);
          if (reservationSnapshot) {
            await tx.appointment.update({
              where: { id: created.id },
              data: {
                inventoryReservedAt: new Date(),
                inventoryReservationSnapshot: reservationSnapshot as any,
                inventoryReservationSource: reservationSnapshot.source,
              },
            });
            (created as any).inventoryReservedAt = new Date();
            (created as any).inventoryReservationSnapshot = reservationSnapshot;
            (created as any).inventoryReservationSource = reservationSnapshot.source;
          }
        }

        await syncMwlFromAppointment(tx, created, branchId);
        return created;
      });

      // Publica evento de agendamento criado para notificação automática no WhatsApp.
      publishAppointmentCreatedEvent({ branchId, appointmentId: item.id });

      return reply.code(201).send(item);
    } catch (err: any) {
      request.log.error({ err }, 'Failed to create appointment');
      return reply.code(400).send({ error: 'Failed to create appointment', details: err.message });
    }
  });

  app.put('/:id', {
    schema: {
      summary: 'Update appointment',
      tags: ['Appointments'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object' },
      response: {
        200: { type: 'object' },
        400: { type: 'object', additionalProperties: true },
        409: { type: 'object', additionalProperties: true },
        403: { type: 'object' },
        404: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const data = request.body as any;

    try {
      const existing = await prisma.appointment.findFirst({ where: { id, branchId } });
      if (!existing) return reply.code(404).send({ error: 'Appointment not found' });
      const notificationRelevantFields: Array<keyof typeof existing> = [
        'patientName',
        'doctorName',
        'specialty',
        'date',
        'time',
      ];
      const shouldResendAppointmentNotification = notificationRelevantFields.some((field) => (
        field in (data || {})
        && (data?.[field] ?? existing[field]) !== existing[field]
      ));

      const item = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const actorUserId = String((request.user as any)?.id || '').trim() || null;
        const updateData = Object.fromEntries(
          Object.entries(data || {}).filter(([key]) => APPOINTMENT_MUTABLE_FIELDS.has(key))
        ) as Record<string, any>;
        const resolvedSpecialty = updateData.specialty ?? existing.specialty;
        const resolvedAppointmentType = updateData.type ?? existing.type;
        const resolvedDoctorName = updateData.doctorName ?? existing.doctorName;
        const resolvedPatientId = updateData.patientId ?? existing.patientId;
        const resolvedPatientCpf = updateData.patientCpf ?? existing.patientCpf;
        const resolvedRoomId = updateData.roomId ?? existing.roomId;
        const resolvedMedicalEquipmentId = updateData.medicalEquipmentId ?? existing.medicalEquipmentId;
        const resolvedDate = updateData.date ?? existing.date;
        const resolvedTime = updateData.time ?? existing.time;
        const resolvedDurationMinutes = Number.isFinite(updateData.durationMinutes)
          ? Number(updateData.durationMinutes)
          : (Number.isFinite(existing.durationMinutes) ? Number(existing.durationMinutes) : 30);
        const nextStatusForConflict = updateData.status ?? existing.status;
        const schedulingChanged = (
          resolvedDoctorName !== existing.doctorName
          || resolvedRoomId !== existing.roomId
          || resolvedMedicalEquipmentId !== existing.medicalEquipmentId
          || resolvedDate !== existing.date
          || resolvedTime !== existing.time
          || resolvedDurationMinutes !== (Number.isFinite(existing.durationMinutes) ? Number(existing.durationMinutes) : 30)
          || nextStatusForConflict !== existing.status
        );

        if ('specialty' in updateData || 'type' in updateData) {
          const mixedProcedureTypes = await hasMixedAppointmentTypeInSpecialty({
            branchId,
            specialty: resolvedSpecialty,
          });
          if (mixedProcedureTypes) {
            throw new Error('MIXED_APPOINTMENT_TYPES');
          }
          const normalizedType = normalizeAppointmentType(resolvedAppointmentType);
          if (
            normalizedType
            && parseProcedureNamesFromSpecialty(resolvedSpecialty).length > 0
            && normalizedType === 'CONSULTA'
            && String(resolvedRoomId || '').trim()
            && String(resolvedMedicalEquipmentId || '').trim()
          ) {
            throw new Error('CONSULTA_WITH_EXAM_RESOURCE');
          }
        }

        if (schedulingChanged && hasBlockingStatus(nextStatusForConflict)) {
          const patientConflict = await findPatientScheduleConflict({
            tx,
            branchId,
            patientId: resolvedPatientId,
            patientCpf: resolvedPatientCpf,
            date: resolvedDate,
            time: resolvedTime,
            durationMinutes: resolvedDurationMinutes,
            excludeAppointmentId: id,
          });
          if (patientConflict) {
            throw new Error('PATIENT_SCHEDULE_CONFLICT::'
              + String(patientConflict.time || '')
              + '::'
              + String(patientConflict.suggestedTime || ''));
          }

          const doctorConflict = await findDoctorScheduleConflict({
            tx,
            branchId,
            doctorName: resolvedDoctorName,
            date: resolvedDate,
            time: resolvedTime,
            durationMinutes: resolvedDurationMinutes,
            excludeAppointmentId: id,
          });
          if (doctorConflict) {
            throw new Error('DOCTOR_SCHEDULE_CONFLICT::' + String(doctorConflict.patientName || 'outro paciente') + '::' + String(doctorConflict.time || ''));
          }

          const resourceConflict = await findResourceScheduleConflict({
            tx,
            branchId,
            roomId: resolvedRoomId,
            medicalEquipmentId: resolvedMedicalEquipmentId,
            date: resolvedDate,
            time: resolvedTime,
            durationMinutes: resolvedDurationMinutes,
            excludeAppointmentId: id,
          });
          if (resourceConflict) {
            throw new Error('RESOURCE_SCHEDULE_CONFLICT');
          }
        }
        if (updateData.authorizationStatus === 'AUTHORIZED' && !existing.authorizedAt) {
          updateData.authorizedAt = new Date();
        }
        if ('accessionNumber' in data) {
          updateData.accessionNumber = data.accessionNumber || null;
        }
        
        if (updateData.authorizationStatus && updateData.authorizationStatus !== 'AUTHORIZED') {
          updateData.authorizedAt = null;
        }

        const prevStatusRaw = updateData.status ?? existing.status;
        const resolvedAccessionNumber = (
          'accessionNumber' in updateData
            ? updateData.accessionNumber
            : existing.accessionNumber
        );
        if (isConfirmedAppointmentStatus(prevStatusRaw) && !hasAccessionNumber(resolvedAccessionNumber)) {
          updateData.accessionNumber = generateAccessionNumber();
        }
        const prevStatus = normalizeStatus(existing.status);
        const nextStatus = normalizeStatus(prevStatusRaw);
        const specialtyChanged = String(updateData.specialty ?? existing.specialty ?? '') !== String(existing.specialty ?? '');
        const convenioChanged = String(updateData.convenio ?? existing.convenio ?? '') !== String(existing.convenio ?? '');
        const shouldRefreshReservation = specialtyChanged || convenioChanged;
        const wasReserved = Boolean(existing.inventoryReservedAt);
        const shouldBeReserved = RESERVABLE_STATUSES.has(nextStatus);
        const existingReservationSnapshot = existing.inventoryReservationSnapshot && typeof existing.inventoryReservationSnapshot === 'object'
          ? (existing.inventoryReservationSnapshot as InventoryReservationSnapshot)
          : null;
        const wasConsumed = Boolean(existing.inventoryConsumedAt);
        const existingSnapshot = existing.inventoryConsumptionSnapshot && typeof existing.inventoryConsumptionSnapshot === 'object'
          ? (existing.inventoryConsumptionSnapshot as InventoryConsumptionSnapshot)
          : null;

        if (shouldBeReserved && (!wasReserved || shouldRefreshReservation)) {
          const reservationSnapshot = await reserveProcedureMaterialsSnapshot(tx, {
            ...existing,
            ...updateData,
          });
          updateData.inventoryReservedAt = reservationSnapshot ? new Date() : null;
          updateData.inventoryReservationSnapshot = reservationSnapshot as any;
          updateData.inventoryReservationSource = reservationSnapshot?.source || null;
        }

        if (!shouldBeReserved && wasReserved && existingReservationSnapshot) {
          updateData.inventoryReservedAt = null;
          updateData.inventoryReservationSnapshot = null;
          updateData.inventoryReservationSource = null;
        }

        if (COMPLETED_STATUSES.has(nextStatus) && !wasConsumed) {
          const consumedSnapshot = await applyProcedureMaterialStock(tx, {
            ...existing,
            ...updateData,
          }, 'consume', null, {
            actorUserId,
            appointmentId: existing.id,
          });
          updateData.inventoryConsumedAt = new Date();
          updateData.inventoryConsumptionSnapshot = consumedSnapshot as any;
          updateData.inventoryConsumptionSource = consumedSnapshot?.source || null;
          updateData.inventoryReservedAt = null;
          updateData.inventoryReservationSnapshot = null;
          updateData.inventoryReservationSource = null;
        }

        if (CANCELED_STATUSES.has(nextStatus) && !CANCELED_STATUSES.has(prevStatus) && wasConsumed) {
          await applyProcedureMaterialStock(tx, existing, 'revert', existingSnapshot, {
            actorUserId,
            appointmentId: existing.id,
          });
          updateData.inventoryConsumedAt = null;
          updateData.inventoryConsumptionSnapshot = null;
          updateData.inventoryConsumptionSource = null;
        }

        if ((CANCELED_STATUSES.has(nextStatus) || NO_SHOW_STATUSES.has(nextStatus)) && wasReserved) {
          updateData.inventoryReservedAt = null;
          updateData.inventoryReservationSnapshot = null;
          updateData.inventoryReservationSource = null;
        }

        const updated = await tx.appointment.update({ where: { id }, data: { ...updateData, branchId } });

        if (!isConfirmedAppointmentStatus(existing.status) && isConfirmedAppointmentStatus(prevStatusRaw)) {
          await markManualConfirmationAsResolved(tx, {
            branchId,
            appointmentId: updated.id,
            patientName: updated.patientName || existing.patientName || null,
          });
        }

        await syncMwlFromAppointment(tx, updated, branchId);
        return updated;
      });

      if (!isNoShowAppointmentStatus(existing.status) && isNoShowAppointmentStatus(item.status)) {
        publishAppointmentNoShowEventIfNeeded({ branchId, appointmentId: item.id });
      }

      if (shouldResendAppointmentNotification) {
        publishAppointmentCreatedEvent({ branchId, appointmentId: item.id });
      }
      return item;
    } catch (err: any) {
      request.log.error({ err }, 'Failed to update appointment');
      if (String(err?.message || '').startsWith('DOCTOR_SCHEDULE_CONFLICT::')) {
        const [, patientName, conflictTime] = String(err.message).split('::');
        return reply.code(409).send({
          error: 'Scheduling conflict',
          conflictType: 'DOCTOR',
          message: 'O médico já possui outra consulta nesse horário.',
          details: 'Conflito com ' + String(patientName || 'outro paciente') + ' às ' + String(conflictTime || '') + '.',
        });
      }
      if (String(err?.message || '').startsWith('PATIENT_SCHEDULE_CONFLICT::')) {
        const [, conflictTime, suggestedTime] = String(err.message).split('::');
        return reply.code(409).send({
          error: 'Scheduling conflict',
          conflictType: 'PATIENT',
          message: 'O paciente já possui outro agendamento nesse horário.',
          details: 'Conflito às ' + String(conflictTime || '') + '.'
            + (suggestedTime ? ` Sugestão: ${suggestedTime}.` : ''),
        });
      }
      if (String(err?.message || '') === 'MIXED_APPOINTMENT_TYPES') {
        return reply.code(400).send({
          error: 'Invalid appointment mix',
          message: 'Não é permitido misturar procedimentos de consulta e exame na mesma marcação.',
        });
      }
      if (String(err?.message || '') === 'CONSULTA_WITH_EXAM_RESOURCE') {
        return reply.code(400).send({
          error: 'Invalid appointment payload',
          message: 'Consulta não pode ser salva com sala e equipamento de exame ao mesmo tempo.',
        });
      }
      if (String(err?.message || '').startsWith('RESOURCE_SCHEDULE_CONFLICT')) {
        return reply.code(409).send({
          error: 'Scheduling conflict',
          conflictType: 'RESOURCE',
          message: 'A sala ou o equipamento já está reservado nesse horário.',
          details: 'Conflito identificado no recurso selecionado.',
        });
      }
      return reply.code(400).send({ error: 'Failed to update appointment', details: err.message });
    }
  });

  app.delete('/:id', {
    schema: {
      summary: 'Delete appointment',
      tags: ['Appointments'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const existing = await prisma.appointment.findFirst({ where: { id, branchId } });
    if (!existing) return reply.code(404).send({ error: 'Appointment not found' });

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.mwlEntry.updateMany({
        where: { appointmentId: id },
        data: { status: 'cancelado', isActive: false },
      });
      await tx.appointment.delete({ where: { id } });
    });

    return { message: 'Deleted' };
  });

  app.post('/:id/create-worklist', {
    schema: {
      summary: 'Create or refresh report worklist from appointment',
      tags: ['Appointments'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const appointment = await prisma.appointment.findFirst({ where: { id, branchId, isActive: true } });
    if (!appointment) return reply.code(404).send({ error: 'Appointment not found' });

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      let appointmentForMwl = appointment;
      if (isConfirmedAppointmentStatus(appointmentForMwl.status) && !hasAccessionNumber(appointmentForMwl.accessionNumber)) {
        appointmentForMwl = await tx.appointment.update({
          where: { id: appointmentForMwl.id },
          data: { accessionNumber: generateAccessionNumber() },
        });
      }
      await syncMwlFromAppointment(tx, appointmentForMwl, branchId);
    });

    const mwlEntry = await prisma.mwlEntry.findFirst({
      where: {
        appointmentId: id,
        OR: [{ branchId }, { branchId: null }],
      },
      orderBy: { updatedAt: 'desc' },
    });

    return { appointmentId: id, mwlEntry };
  });

  // List online (self-scheduled) appointments pending operator review
  app.get('/online', {
    schema: {
      summary: 'List pre-scheduled appointments from patient portal',
      tags: ['Appointments'],
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const appointments = await prisma.appointment.findMany({
      where: { branchId, status: 'PRE_AGENDADO' },
      orderBy: [{ date: 'asc' }, { time: 'asc' }],
      select: {
        id: true,
        patientName: true,
        patientCpf: true,
        doctorName: true,
        specialty: true,
        date: true,
        time: true,
        type: true,
        convenio: true,
        observations: true,
        durationMinutes: true,
        createdAt: true,
      },
    });

    return { appointments };
  });

  // Confirm (accept) or reject an online pre-scheduled appointment
  app.patch('/online/:id', {
    schema: {
      summary: 'Confirm or reject an online pre-scheduled appointment',
      tags: ['Appointments'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['confirm', 'reject'] },
          reason: { type: 'string' },
        },
        required: ['action'],
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as { id: string };
    const { action, reason } = request.body as { action: 'confirm' | 'reject'; reason?: string };

    const appointment = await prisma.appointment.findFirst({ where: { id, branchId, status: 'PRE_AGENDADO' } });
    if (!appointment) return reply.code(404).send({ error: 'Pré-agendamento não encontrado' });

    if (action === 'confirm') {
      await prisma.appointment.update({ where: { id }, data: { status: 'AGENDADO' } });
      return { ok: true, status: 'AGENDADO' };
    } else {
      const obs = reason ? `[RECUSADO: ${reason}]` : '[RECUSADO PELO OPERADOR]';
      await prisma.appointment.update({
        where: { id },
        data: {
          status: 'CANCELADO',
          observations: appointment.observations ? `${obs}\n${appointment.observations}` : obs,
        },
      });
      return { ok: true, status: 'CANCELADO' };
    }
  });
}
