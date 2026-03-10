import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function reportAddendumRoutes(app: FastifyInstance) {
  app.get('/', {
    schema: {
      summary: 'List report addendums',
      tags: ['Report Addendums'],
      querystring: {
        type: 'object',
        properties: {
          worklistItemId: { type: 'string' },
          status: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { worklistItemId, status, limit = 50, offset = 0 } = request.query as any;

    if (!worklistItemId) {
      return reply.code(400).send({ error: 'worklistItemId is required' });
    }

    const where: any = {
      worklistItemId,
      isActive: true,
    };

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
    const data = request.body as any;

    try {
      const worklistItem = await prisma.reportWorklistItem.findUnique({ where: { id: data.worklistItemId } });
      if (!worklistItem) {
        return reply.code(404).send({ error: 'Report worklist item not found' });
      }

      const item = await prisma.reportAddendum.create({
        data: {
          worklistItemId: data.worklistItemId,
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
    const { id } = request.params as any;
    const data = request.body as any;

    try {
      const existing = await prisma.reportAddendum.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: 'Report addendum not found' });

      const item = await prisma.reportAddendum.update({ where: { id }, data });
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
    const { id } = request.params as any;
    await prisma.reportAddendum.delete({ where: { id } });
    return { message: 'Deleted' };
  });
}
