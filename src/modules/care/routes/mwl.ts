import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function mwlRoutes(app: FastifyInstance) {
  const mwlPublicToken = process.env.MWL_PUBLIC_TOKEN || '';

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
    // Public feed is used by equipment connector (dcm4che/bridge) and does not use JWT.
    const pathOnly = String(request.url || '').split('?')[0];
    if (request.method === 'GET' && pathOnly.endsWith('/public-feed')) {
      const token = String((request.headers['x-mwl-token'] as string) || (request.query as any)?.token || '');
      if (!mwlPublicToken || token !== mwlPublicToken) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      return;
    }

    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // Public feed consumed by MWL bridge (equipment integration).
  // Access is protected by x-mwl-token/token query and requires branchId.
  app.get('/public-feed', {
    schema: {
      summary: 'Public MWL feed for equipment bridge',
      tags: ['MWL'],
      querystring: {
        type: 'object',
        required: ['branchId'],
        properties: {
          branchId: { type: 'string' },
          accessionNumber: { type: 'string' },
          patientId: { type: 'string' },
          status: { type: 'string', description: 'Default: agendado' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          limit: { type: 'number', default: 100 },
          token: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const {
      branchId,
      accessionNumber,
      patientId,
      status = 'agendado',
      date,
      limit = 100,
    } = request.query as any;

    const where: any = { branchId, isActive: true };
    if (status) where.status = status;
    if (date) where.scheduledAt = { startsWith: date };
    if (accessionNumber) where.accessionNumber = accessionNumber;
    if (patientId) where.patientCpf = patientId;

    const items = await prisma.mwlEntry.findMany({
      where,
      take: Math.min(Number(limit) || 100, 500),
      orderBy: { scheduledAt: 'asc' },
      include: {
        appointment: {
          select: {
            id: true,
            patientName: true,
            patientCpf: true,
            doctorName: true,
            date: true,
            time: true,
            specialty: true,
          },
        },
      },
    });

    const feed = items.map((it: any) => ({
      id: it.id,
      accessionNumber: it.accessionNumber || null,
      patientName: it.appointment?.patientName || it.patientName || null,
      patientId: it.appointment?.patientCpf || it.patientCpf || null,
      examType: it.examType || it.appointment?.specialty || null,
      modalityHint: it.examType || null,
      scheduledAt: it.scheduledAt || null,
      requestingDoctor: it.appointment?.doctorName || it.requestingDoctor || null,
      appointmentId: it.appointmentId || it.appointment?.id || null,
      status: it.status || 'agendado',
    }));

    return { items: feed, total: feed.length };
  });

  // List worklist entries — intended for UI display and equipment polling
  app.get('/', {
    schema: {
      summary: 'List MWL entries (scheduled exams)',
      tags: ['MWL'],
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'agendado | adquirido | cancelado | finalizado' },
          search: { type: 'string' },
          date: { type: 'string', description: 'Filter by scheduledAt date (YYYY-MM-DD)' },
          limit: { type: 'number', default: 100 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { status, search, date, limit = 100, offset = 0 } = request.query as any;

    const where: any = { branchId, isActive: true };
    if (status) where.status = status;
    if (date) where.scheduledAt = { startsWith: date };
    if (search) {
      where.OR = [
        { patientName: { contains: search, mode: 'insensitive' } },
        { patientCpf: { contains: search } },
        { accessionNumber: { contains: search } },
        { examType: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.mwlEntry.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { scheduledAt: 'asc' },
        include: {
          appointment: {
            select: { id: true, patientName: true, patientCpf: true, specialty: true, date: true, time: true, status: true },
          },
          worklistItems: {
            select: { id: true, dicomStudyUid: true, dicomUrl: true, dicomReceivedAt: true, accessionNumber: true },
          },
        },
      }),
      prisma.mwlEntry.count({ where }),
    ]);

    return { items, total };
  });

  app.get('/:id', {
    schema: {
      summary: 'Get MWL entry by ID',
      tags: ['MWL'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const item = await prisma.mwlEntry.findFirst({
      where: { id, branchId },
      include: {
        appointment: true,
        worklistItems: {
          include: {
            laudos: { select: { id: true, status: true, createdAt: true } },
            dicomFiles: { select: { id: true, studyUid: true, seriesUid: true, createdAt: true } },
          },
        },
      },
    });

    if (!item) return reply.code(404).send({ error: 'MWL entry not found' });
    return item;
  });

  app.put('/:id', {
    schema: {
      summary: 'Update MWL entry (e.g. set accessionNumber)',
      tags: ['MWL'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        properties: {
          accessionNumber: { type: 'string' },
          patientName: { type: 'string' },
          patientCpf: { type: 'string' },
          examType: { type: 'string' },
          scheduledAt: { type: 'string' },
          convenio: { type: 'string' },
          requestingDoctor: { type: 'string' },
          status: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const data = request.body as any;

    const existing = await prisma.mwlEntry.findFirst({ where: { id, branchId } });
    if (!existing) return reply.code(404).send({ error: 'MWL entry not found' });

    const item = await prisma.mwlEntry.update({ where: { id }, data: { ...data, branchId } });
    return item;
  });
}
