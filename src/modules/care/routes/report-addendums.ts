import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function reportAddendumRoutes(app: FastifyInstance) {
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
      summary: 'List report addendums',
      tags: ['Report Addendums'],
      querystring: {
        type: 'object',
        properties: {
          worklistItemId: { type: 'string' },
          reportId: { type: 'string' },
          status: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { worklistItemId, reportId, status, limit = 50, offset = 0 } = request.query as any;

    if (!worklistItemId && !reportId) {
      return reply.code(400).send({ error: 'worklistItemId or reportId is required' });
    }

    const where: any = {
      branchId,
      isActive: true,
    };

    if (worklistItemId) where.worklistItemId = worklistItemId;
    if (reportId) where.reportId = reportId;
    if (status) where.status = status;

    const [items, total] = await Promise.all([
      prisma.reportAddendum.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.reportAddendum.count({ where }),
    ]);

    return { items, total };
  });

  app.post('/', {
    schema: {
      summary: 'Create report addendum draft',
      tags: ['Report Addendums'],
      body: {
        type: 'object',
        required: ['worklistItemId'],
        properties: {
          worklistItemId: { type: 'string', minLength: 1 },
          reportId: { type: 'string', minLength: 1 },
          content: { type: 'string' },
          status: { type: 'string' },
          issuerSignedAt: { type: 'string' },
          reviewerSignedAt: { type: 'string' },
          savedAt: { type: 'string' },
          finalizedAt: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;

    if (!data.worklistItemId && !data.reportId) {
      return reply.code(400).send({ error: 'worklistItemId or reportId is required' });
    }

    try {
      if (data.worklistItemId) {
        const worklistItem = await prisma.reportWorklistItem.findFirst({ where: { id: data.worklistItemId, branchId } });
        if (!worklistItem) {
          return reply.code(404).send({ error: 'Report worklist item not found' });
        }
      }

      if (data.reportId) {
        const report = await prisma.report.findFirst({ where: { id: data.reportId, branchId } });
        if (!report) {
          return reply.code(404).send({ error: 'Report (laudo) not found' });
        }
      }

      const item = await prisma.reportAddendum.create({
        data: {
          branchId,
          worklistItemId: data.worklistItemId || null,
          reportId: data.reportId || null,
          content: data.content || '',
          status: data.status || 'draft',
          issuerSignedAt: data.issuerSignedAt || null,
          reviewerSignedAt: data.reviewerSignedAt || null,
          savedAt: data.savedAt || null,
          finalizedAt: data.finalizedAt || null,
        },
      });

      return reply.code(201).send(item);
    } catch (err: any) {
      request.log.error({ err }, 'Failed to create report addendum');
      return reply.code(400).send({ error: 'Failed to create report addendum', details: err.message });
    }
  });

  app.put('/:id', {
    schema: {
      summary: 'Update report addendum',
      tags: ['Report Addendums'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object' },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const data = request.body as any;

    try {
      const existing = await prisma.reportAddendum.findFirst({ where: { id, branchId } });
      if (!existing) return reply.code(404).send({ error: 'Report addendum not found' });

      const item = await prisma.reportAddendum.update({ where: { id }, data: { ...data, branchId } });
      return item;
    } catch (err: any) {
      request.log.error({ err }, 'Failed to update report addendum');
      return reply.code(400).send({ error: 'Failed to update report addendum', details: err.message });
    }
  });

  app.delete('/:id', {
    schema: {
      summary: 'Delete report addendum',
      tags: ['Report Addendums'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const existing = await prisma.reportAddendum.findFirst({ where: { id, branchId } });
    if (!existing) return reply.code(404).send({ error: 'Report addendum not found' });
    await prisma.reportAddendum.delete({ where: { id } });
    return { message: 'Deleted' };
  });
}
