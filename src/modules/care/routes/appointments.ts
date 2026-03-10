import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

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
          convenio: { type: 'string' },
          date: { type: 'string' },
          time: { type: 'string' },
          type: { type: 'string' },
          status: { type: 'string' },
          authorizationStatus: { type: 'string' },
          authorizationNotes: { type: 'string' },
          observations: { type: 'string' },
          totem: { type: 'number' },
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
      const item = await prisma.appointment.create({ data: {
        branchId,
        patientName: data.patientName || null,
        patientCpf: data.patientCpf || null,
        patientId: data.patientId || null,
        doctorName: data.doctorName || null,
        specialty: data.specialty || null,
        convenio: data.convenio || null,
        date: data.date || null,
        time: data.time || null,
        type: data.type || null,
        status: data.status || null,
        authorizationStatus: data.authorizationStatus || 'PENDING',
        authorizationNotes: data.authorizationNotes || null,
        authorizedAt: data.authorizationStatus === 'AUTHORIZED' ? new Date() : null,
        observations: data.observations || null,
        totem: data.totem ?? null,
      } });

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

      const updateData = { ...data } as any;
      if (updateData.authorizationStatus === 'AUTHORIZED' && !existing.authorizedAt) {
        updateData.authorizedAt = new Date();
      }
      if (updateData.authorizationStatus && updateData.authorizationStatus !== 'AUTHORIZED') {
        updateData.authorizedAt = null;
      }

      const item = await prisma.appointment.update({ where: { id }, data: { ...updateData, branchId } });
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
    await prisma.appointment.delete({ where: { id } });
    return { message: 'Deleted' };
  });
}
