import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';
import type { Prisma } from '@prisma/client';
import WhatsAppAutoSender from '../lib/whatsapp-auto-sender';

const COMPLETED_STATUSES = new Set(['REALIZADO', 'COMPLETED', 'FINALIZADO', 'ATENDIDO']);
const CANCELED_STATUSES = new Set(['CANCELADO', 'CANCELED']);

const normalizeStatus = (status?: string | null) => String(status || '').trim().toUpperCase();

const mapAppointmentStatusToWorklistStatus = (status?: string | null) => {
  const normalized = normalizeStatus(status);
  if (CANCELED_STATUSES.has(normalized)) return 'cancelado';
  if (COMPLETED_STATUSES.has(normalized)) return 'finalizado';
  if (normalized === 'CONFIRMED' || normalized === 'CONFIRMADO') return 'confirmado';
  if (normalized === 'EM ANDAMENTO' || normalized === 'EM_ANDAMENTO' || normalized === 'IN_PROGRESS') return 'em_andamento';
  return 'agendado';
};

const generateAccessionNumber = () => {
  // AcessionNumber deve ser único para correlação MWL/DICOM.
  // Usamos timestamp + random para evitar colisões em ambiente de alta concorrência.
  return `ACC-${Date.now()}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
};

// Creates or updates the MwlEntry linked to this appointment.
// MwlEntry is what the imaging equipment queries via MWL/C-FIND.
// It is NOT the DICOM index — that is ReportWorklistItem, created later when the image arrives.
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
    
    // Search (só aplica se não tiver filtros específicos de paciente)
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
        },
      },
      response: {
        201: { type: 'object' },
        400: { type: 'object', additionalProperties: true },
        403: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;
    try {
      const item = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const created = await tx.appointment.create({ data: {
          branchId,
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
