import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function reportWorklistRoutes(app: FastifyInstance) {
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
      summary: 'List report worklist items',
      tags: ['Report Worklist'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          status: { type: 'string' },
          examType: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { search, status, examType, limit = 50, offset = 0 } = request.query as any;

    // show items that either belong to this branch or have no branch assigned (imported by poller)
    const where: any = { isActive: true, OR: [{ branchId }, { branchId: null }] };
    if (status) where.status = status;
    if (examType) where.examType = examType;
    if (search) {
      where.AND = where.AND || [];
      where.AND.push({
        OR: [
          { patientName: { contains: search, mode: 'insensitive' } },
          { patientCpf: { contains: search, mode: 'insensitive' } },
          { examType: { contains: search, mode: 'insensitive' } },
          { accessionNumber: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    const [items, total] = await Promise.all([
      prisma.reportWorklistItem.findMany({ where, take: limit, skip: offset, orderBy: { createdAt: 'desc' } }),
      prisma.reportWorklistItem.count({ where }),
    ]);

    const itemIds = (items as any[]).map((item: any) => item.id);
    const addendumCounts = itemIds.length
      ? await prisma.reportAddendum.groupBy({
          by: ['worklistItemId'],
          where: {
            branchId,
            isActive: true,
            status: 'finalizado',
            worklistItemId: { in: itemIds },
          },
          _count: { _all: true },
        })
      : [];

    const addendumCountByItemId = new Map<string, number>(
      (addendumCounts as any[]).map((row: any) => [String(row.worklistItemId), Number(row._count?._all || 0)]),
    );
    const itemsWithFlags = (items as any[]).map((item: any) => ({
      ...item,
      hasFinalizedAddendum: Boolean((addendumCountByItemId.get(item.id) || 0) > 0),
    }));

    return { items: itemsWithFlags, total };
  });

  app.get('/:id', {
    schema: {
      summary: 'Get report worklist item by ID',
      tags: ['Report Worklist'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const item = await prisma.reportWorklistItem.findFirst({ where: { id, OR: [{ branchId }, { branchId: null }] } });
    if (!item) return reply.code(404).send({ error: 'Report worklist item not found' });

    const finalizedAddendumCount = await prisma.reportAddendum.count({
      where: {
        branchId,
        worklistItemId: id,
        isActive: true,
        status: 'finalizado',
      },
    });

    return {
      ...item,
      hasFinalizedAddendum: finalizedAddendumCount > 0,
    };
  });

  app.post('/', {
    schema: {
      summary: 'Create report worklist item',
      tags: ['Report Worklist'],
      body: {
        type: 'object',
        required: ['patientName', 'examType'],
        properties: {
          externalStudyId: { type: 'string' },
          accessionNumber: { type: 'string' },
          patientName: { type: 'string', minLength: 1 },
          patientCpf: { type: 'string' },
          patientBirthDate: { type: 'string' },
          examType: { type: 'string', minLength: 1 },
          scheduledAt: { type: 'string' },
          convenio: { type: 'string' },
          requestingDoctor: { type: 'string' },
          assignedTo: { type: 'string' },
          priority: { type: 'string' },
          status: { type: 'string' },
          reportText: { type: 'string' },
          issuerSignedAt: { type: 'string' },
          reviewerSignedAt: { type: 'string' },
          dicomStudyUid: { type: 'string' },
          dicomSeriesUid: { type: 'string' },
          dicomPath: { type: 'string' },
          dicomUrl: { type: 'string' },
          dicomReceivedAt: { type: 'string', format: 'date-time' },
          metadata: { type: 'object', additionalProperties: true },
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

    if (!data.patientName || !String(data.patientName).trim()) {
      return reply.code(400).send({ error: 'patientName is required' });
    }
    if (!data.examType || !String(data.examType).trim()) {
      return reply.code(400).send({ error: 'examType is required' });
    }

    try {
      const item = await prisma.reportWorklistItem.create({
        data: {
          branchId,
          externalStudyId: data.externalStudyId || null,
          accessionNumber: data.accessionNumber || null,
          patientName: data.patientName,
          patientCpf: data.patientCpf || null,
          patientBirthDate: data.patientBirthDate || null,
          examType: data.examType,
          scheduledAt: data.scheduledAt || null,
          convenio: data.convenio || null,
          requestingDoctor: data.requestingDoctor || null,
          assignedTo: data.assignedTo || null,
          priority: data.priority || 'normal',
          status: data.status || 'pendente',
          reportText: data.reportText || null,
          issuerSignedAt: data.issuerSignedAt || null,
          reviewerSignedAt: data.reviewerSignedAt || null,
          dicomStudyUid: data.dicomStudyUid || null,
          dicomSeriesUid: data.dicomSeriesUid || null,
          dicomPath: data.dicomPath || null,
          dicomUrl: data.dicomUrl || null,
          dicomReceivedAt: data.dicomReceivedAt || null,
          metadata: data.metadata || null,
        },
      });

      return reply.code(201).send(item);
    } catch (err: any) {
      request.log.error({ err }, 'Failed to create report worklist item');
      return reply.code(400).send({ error: 'Failed to create report worklist item', details: err.message });
    }
  });

  app.put('/:id', {
    schema: {
      summary: 'Update report worklist item',
      tags: ['Report Worklist'],
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
      const existing = await prisma.reportWorklistItem.findFirst({ where: { id, OR: [{ branchId }, { branchId: null }] } });
      if (!existing) return reply.code(404).send({ error: 'Report worklist item not found' });

      const isAttemptingUnfinalize =
        existing.status === 'finalizado'
        && typeof data?.status === 'string'
        && data.status !== 'finalizado';

      if (isAttemptingUnfinalize) {
        const finalizedAddendumCount = await prisma.reportAddendum.count({
          where: {
            branchId,
            worklistItemId: id,
            isActive: true,
            status: 'finalizado',
          },
        });

        if (finalizedAddendumCount > 0) {
          return reply.code(400).send({ error: 'Cannot unfinalize report with finalized addendum' });
        }
      }

      const item = await prisma.reportWorklistItem.update({ where: { id }, data: { ...data, branchId } });
      return item;
    } catch (err: any) {
      request.log.error({ err }, 'Failed to update report worklist item');
      return reply.code(400).send({ error: 'Failed to update report worklist item', details: err.message });
    }
  });

  app.delete('/:id', {
    schema: {
      summary: 'Delete report worklist item',
      tags: ['Report Worklist'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const existing = await prisma.reportWorklistItem.findFirst({ where: { id, OR: [{ branchId }, { branchId: null }] } });
    if (!existing) return reply.code(404).send({ error: 'Report worklist item not found' });
    await prisma.reportWorklistItem.delete({ where: { id } });
    return { message: 'Deleted' };
  });
}
