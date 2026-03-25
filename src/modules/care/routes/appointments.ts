import { randomBytes } from 'crypto';
import { FastifyInstance } from 'fastify';
import { Storage } from '@google-cloud/storage';
import prisma from '../lib/prisma';
import type { Prisma } from '@prisma/client';
import WhatsAppAutoSender from '../lib/whatsapp-auto-sender';

const COMPLETED_STATUSES = new Set(['REALIZADO', 'COMPLETED', 'FINALIZADO', 'ATENDIDO']);
const CANCELED_STATUSES = new Set(['CANCELADO', 'CANCELED']);
const NO_SHOW_STATUSES = new Set(['NAO_COMPARECEU', 'NÃƒO_COMPARECEU', 'NO_SHOW', 'NO-SHOW', 'AUSENTE', 'FALTOU']);

const normalizeStatus = (status?: string | null) => String(status || '').trim().toUpperCase();

const mapAppointmentStatusToWorklistStatus = (status?: string | null) => {
  const normalized = normalizeStatus(status);
  if (CANCELED_STATUSES.has(normalized)) return 'cancelado';
  if (NO_SHOW_STATUSES.has(normalized)) return 'cancelado';
  if (COMPLETED_STATUSES.has(normalized)) return 'finalizado';
  if (normalized === 'CONFIRMED' || normalized === 'CONFIRMADO') return 'confirmado';
  if (normalized === 'EM ANDAMENTO' || normalized === 'EM_ANDAMENTO' || normalized === 'IN_PROGRESS') return 'em_andamento';
  return 'agendado';
};

const generateAccessionNumber = () => {
  // AcessionNumber deve ser Ãºnico para correlaÃ§Ã£o MWL/DICOM.
  // Usamos timestamp + random para evitar colisÃµes em ambiente de alta concorrÃªncia.
  return `ACC-${Date.now()}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
};

const CLINIC_TIME_ZONE = process.env.APP_TIMEZONE || process.env.TZ || 'America/Sao_Paulo';

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

const applyProcedureMaterialStock = async (
  tx: Prisma.TransactionClient,
  appointment: { branchId?: string | null; specialty?: string | null },
  mode: 'consume' | 'revert',
) => {
  const procedureName = String(appointment.specialty || '').trim();
  if (!procedureName) return;

  const procedure = await tx.procedure.findFirst({
    where: {
      branchId: appointment.branchId || undefined,
      name: { equals: procedureName, mode: 'insensitive' },
    },
  });
  if (!procedure) return;

  const materials = await tx.procedureMaterial.findMany({
    where: { procedureId: procedure.id },
  });
  if (!materials.length) return;

  if (mode === 'consume') {
    for (const material of materials) {
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

      await recomputeInventoryItemStatus(tx, material.inventoryItemId);
    }
    return;
  }

  for (const material of materials) {
    await tx.inventoryItem.update({
      where: { id: material.inventoryItemId },
      data: { quantity: { increment: material.quantity } },
    });
    await recomputeInventoryItemStatus(tx, material.inventoryItemId);
  }
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

    const where: any = { isActive: true, branchId };
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
      where.OR = [
        { patientName: { contains: search, mode: 'insensitive' } },
        { patientCpf: { contains: search, mode: 'insensitive' } },
        { doctorName: { contains: search, mode: 'insensitive' } },
      ];
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
          message: 'O médico já possui outra consulta nesse horário.',
          details: 'Conflito com ' + String(doctorConflict.patientName || 'outro paciente') + ' às ' + String(doctorConflict.time || '') + '.',
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

        await syncMwlFromAppointment(tx, created, branchId);
        return created;
      });

      // Enviar mensagem WhatsApp automaticamente (fire and forget)
      WhatsAppAutoSender.sendAppointmentCreatedMessage(branchId, item.id);

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

      const item = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const updateData = { ...data } as any;
        const resolvedDoctorName = updateData.doctorName ?? existing.doctorName;
        const resolvedDate = updateData.date ?? existing.date;
        const resolvedTime = updateData.time ?? existing.time;
        const resolvedDurationMinutes = Number.isFinite(updateData.durationMinutes)
          ? Number(updateData.durationMinutes)
          : (Number.isFinite(existing.durationMinutes) ? Number(existing.durationMinutes) : 30);
        const nextStatusForConflict = updateData.status ?? existing.status;
        const schedulingChanged = (
          resolvedDoctorName !== existing.doctorName
          || resolvedDate !== existing.date
          || resolvedTime !== existing.time
          || resolvedDurationMinutes !== (Number.isFinite(existing.durationMinutes) ? Number(existing.durationMinutes) : 30)
          || nextStatusForConflict !== existing.status
        );
        if (schedulingChanged && hasBlockingStatus(nextStatusForConflict)) {
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

        const prevStatus = normalizeStatus(existing.status);
        const nextStatus = normalizeStatus(updateData.status ?? existing.status);
        const wasConsumed = Boolean(existing.inventoryConsumedAt);

        if (COMPLETED_STATUSES.has(nextStatus) && !wasConsumed) {
          await applyProcedureMaterialStock(tx, existing, 'consume');
          updateData.inventoryConsumedAt = new Date();
        }

        if (CANCELED_STATUSES.has(nextStatus) && !CANCELED_STATUSES.has(prevStatus) && wasConsumed) {
          await applyProcedureMaterialStock(tx, existing, 'revert');
          updateData.inventoryConsumedAt = null;
        }

        const updated = await tx.appointment.update({ where: { id }, data: { ...updateData, branchId } });
        await syncMwlFromAppointment(tx, updated, branchId);
        return updated;
      });
      return item;
    } catch (err: any) {
      request.log.error({ err }, 'Failed to update appointment');
      if (String(err?.message || '').startsWith('DOCTOR_SCHEDULE_CONFLICT::')) {
        const [, patientName, conflictTime] = String(err.message).split('::');
        return reply.code(409).send({
          error: 'Scheduling conflict',
          message: 'O médico já possui outra consulta nesse horário.',
          details: 'Conflito com ' + String(patientName || 'outro paciente') + ' às ' + String(conflictTime || '') + '.',
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
      await syncMwlFromAppointment(tx, appointment, branchId);
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
}
