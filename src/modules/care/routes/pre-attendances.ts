import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function preAttendanceRoutes(app: FastifyInstance) {
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
      summary: 'List pre-attendances',
      tags: ['PreAttendance'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          status: { type: 'string' },
          queueType: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return { items: [], total: 0 };

    const { search, status, queueType, limit = 50, offset = 0 } = request.query as any;

    const where: any = { isActive: true, branchId };
    if (status) where.status = status;
    if (queueType) where.queueType = queueType;
    if (search) {
      where.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        { cpf: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.preAttendance.findMany({ where, take: limit, skip: offset, orderBy: { createdAt: 'desc' } }),
      prisma.preAttendance.count({ where }),
    ]);

    return { items, total };
  });

  app.get('/:id', {
    schema: {
      summary: 'Get pre-attendance by ID',
      tags: ['PreAttendance'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const item = await prisma.preAttendance.findFirst({ where: { id, branchId } });
    if (!item) return reply.code(404).send({ error: 'Pre-attendance not found' });
    return item;
  });

  app.post('/', {
    schema: {
      summary: 'Create pre-attendance',
      tags: ['PreAttendance'],
      body: {
        type: 'object',
        required: ['fullName', 'cpf'],
        properties: {
          fullName: { type: 'string' },
          cpf: { type: 'string' },
          patientId: { type: 'string' },
          birthDate: { type: 'string' },
          gender: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          address: { type: 'string' },
          convenio: { type: 'string' },
          convenioType: { type: 'string' },
          convenioValidUntil: { type: 'string' },
          convenioNumber: { type: 'string' },
          convenioStatus: { type: 'string' },
          convenioNotes: { type: 'string' },
          bloodPressure: { type: 'string' },
          heartRate: { type: 'string' },
          temperature: { type: 'string' },
          oxygenSaturation: { type: 'string' },
          weight: { type: 'string' },
          height: { type: 'string' },
          glucose: { type: 'string' },
          bmi: { type: 'string' },
          mainComplaint: { type: 'string' },
          diseaseHistory: { type: 'string' },
          allergies: { type: 'string' },
          medications: { type: 'string' },
          antecedentes: { type: 'string' },
          triageNotes: { type: 'string' },
          notes: { type: 'string' },
          totem: { type: 'number' },
          status: { type: 'string' },
          queue: { type: 'string' },
          queueType: { type: 'string' },
          agenda: { type: 'string' },
          doctorId: { type: 'string' },
          doctorName: { type: 'string' },
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
      const item = await prisma.preAttendance.create({ data: {
        branchId,
        fullName: data.fullName,
        cpf: data.cpf,
        patientId: data.patientId || null,
        birthDate: data.birthDate || null,
        gender: data.gender || null,
        phone: data.phone || null,
        email: data.email || null,
        address: data.address || null,
        convenio: data.convenio || null,
        convenioType: data.convenioType || null,
        convenioValidUntil: data.convenioValidUntil || null,
        convenioNumber: data.convenioNumber || null,
        convenioStatus: data.convenioStatus || null,
        convenioNotes: data.convenioNotes || null,
        bloodPressure: data.bloodPressure || null,
        heartRate: data.heartRate || null,
        temperature: data.temperature || null,
        oxygenSaturation: data.oxygenSaturation || null,
        weight: data.weight || null,
        height: data.height || null,
        glucose: data.glucose || null,
        bmi: data.bmi || null,
        mainComplaint: data.mainComplaint || null,
        diseaseHistory: data.diseaseHistory || null,
        allergies: data.allergies || null,
        medications: data.medications || null,
        antecedentes: data.antecedentes || null,
        triageNotes: data.triageNotes || null,
        notes: data.notes || null,
        totem: data.totem ?? null,
        status: data.status || null,
        queue: data.queue || null,
        queueType: data.queueType || null,
        agenda: data.agenda || null,
        doctorId: data.doctorId || null,
        doctorName: data.doctorName || null,
      } });

      return reply.code(201).send(item);
    } catch (err: any) {
      request.log.error({ err }, 'Failed to create pre-attendance');
      return reply.code(400).send({ error: 'Failed to create pre-attendance', details: err.message });
    }
  });

  app.put('/:id', {
    schema: {
      summary: 'Update pre-attendance',
      tags: ['PreAttendance'],
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
      const existing = await prisma.preAttendance.findFirst({ where: { id, branchId } });
      if (!existing) return reply.code(404).send({ error: 'Pre-attendance not found' });

      const item = await prisma.preAttendance.update({ where: { id }, data: { ...data, branchId } });
      return item;
    } catch (err: any) {
      request.log.error({ err }, 'Failed to update pre-attendance');
      return reply.code(400).send({ error: 'Failed to update pre-attendance', details: err.message });
    }
  });

  app.delete('/:id', {
    schema: {
      summary: 'Delete pre-attendance',
      tags: ['PreAttendance'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const existing = await prisma.preAttendance.findFirst({ where: { id, branchId } });
    if (!existing) return reply.code(404).send({ error: 'Pre-attendance not found' });
    await prisma.preAttendance.delete({ where: { id } });
    return { message: 'Deleted' };
  });
}
