import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function consultationRoutes(app: FastifyInstance) {
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
      summary: 'List consultations',
      tags: ['Consultations'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          convenioStatus: { type: 'string' },
          queueType: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { search, convenioStatus, queueType, limit = 50, offset = 0 } = request.query as any;

    const where: any = { isActive: true, branchId };
    if (convenioStatus) where.convenioStatus = convenioStatus;
    if (queueType) where.queueType = queueType;
    if (search) {
      where.OR = [
        { patientName: { contains: search, mode: 'insensitive' } },
        { convenio: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.consultation.findMany({ where, take: limit, skip: offset, orderBy: { createdAt: 'desc' } }),
      prisma.consultation.count({ where }),
    ]);

    return { items, total };
  });

  app.get('/:id', {
    schema: {
      summary: 'Get consultation by ID',
      tags: ['Consultations'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const item = await prisma.consultation.findFirst({ where: { id, branchId } });
    if (!item) return reply.code(404).send({ error: 'Consultation not found' });
    return item;
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
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;
    try {
      const item = await prisma.consultation.create({ data: {
        branchId,
        patientName: data.patientName,
        convenio: data.convenio || null,
        convenioStatus: data.convenioStatus || null,
        scheduledFor: data.scheduledFor || null,
        queueType: data.queueType || null,
        agenda: data.agenda || null,
        totem: data.totem || null,
        queue: data.queue || null,
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
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const data = request.body as any;

    try {
      const existing = await prisma.consultation.findFirst({ where: { id, branchId } });
      if (!existing) return reply.code(404).send({ error: 'Consultation not found' });

      const item = await prisma.consultation.update({ where: { id }, data: { ...data, branchId } });
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
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const existing = await prisma.consultation.findFirst({ where: { id, branchId } });
    if (!existing) return reply.code(404).send({ error: 'Consultation not found' });
    await prisma.consultation.delete({ where: { id } });
    return { message: 'Deleted' };
  });
}
