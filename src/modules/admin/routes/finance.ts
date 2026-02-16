import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function financeRoutes(app: FastifyInstance) {
  // List entries
  app.get('/', {
    schema: {
      summary: 'List finance entries',
      tags: ['Finance'],
      querystring: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          status: { type: 'string' },
          search: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { type, status, search, limit = 50, offset = 0 } = request.query as any;

    const where: any = { isActive: true };
    if (type) where.type = type;
    if (status) where.status = status;
    if (search) where.OR = [
      { description: { contains: search, mode: 'insensitive' } },
      { relatedName: { contains: search, mode: 'insensitive' } },
    ];

    const [items, total] = await Promise.all([
      prisma.financeEntry.findMany({ where, take: limit, skip: offset, orderBy: { createdAt: 'desc' } }),
      prisma.financeEntry.count({ where }),
    ]);

    return { items, total };
  });

  // Get by id
  app.get('/:id', {
    schema: {
      summary: 'Get finance entry by ID',
      tags: ['Finance'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const item = await prisma.financeEntry.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: 'Entry not found' });
    return item;
  });

  // Create
  app.post('/', {
    schema: {
      summary: 'Create finance entry',
      tags: ['Finance'],
      body: { $ref: 'FinanceEntryCreate#' },
      response: { 201: { $ref: 'FinanceEntry#' }, 400: { type: 'object', additionalProperties: true } },
    },
  }, async (request, reply) => {
    const data = request.body as any;

    try {
      const total = (data.value || 0) - (data.discount || 0);
      const entry = await prisma.financeEntry.create({ data: {
        type: data.type,
        category: data.category || null,
        description: data.description || null,
        value: data.value,
        discount: data.discount || 0,
        total: total,
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        status: data.status || 'PENDING',
        paymentMethod: data.paymentMethod || null,
        relatedName: data.relatedName || null,
      } });

      return reply.code(201).send(entry);
    } catch (err: any) {
      request.log.error({ err }, 'Failed to create finance entry');
      return reply.code(400).send({ error: 'Failed to create', details: err.message });
    }
  });

  // Update
  app.put('/:id', {
    schema: {
      summary: 'Update finance entry',
      tags: ['Finance'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { $ref: 'FinanceEntryUpdate#' },
      response: { 200: { $ref: 'FinanceEntry#' }, 400: { type: 'object', additionalProperties: true } },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const data = request.body as any;

    try {
      if (data.value !== undefined || data.discount !== undefined) {
        const existing = await prisma.financeEntry.findUnique({ where: { id } });
        const value = data.value !== undefined ? data.value : Number(existing?.value || 0);
        const discount = data.discount !== undefined ? data.discount : Number(existing?.discount || 0);
        data.total = value - discount;
      }

      const entry = await prisma.financeEntry.update({ where: { id }, data });
      return entry;
    } catch (err: any) {
      request.log.error({ err }, 'Failed to update finance entry');
      return reply.code(400).send({ error: 'Failed to update', details: err.message });
    }
  });

  // Delete
  app.delete('/:id', {
    schema: {
      summary: 'Delete finance entry',
      tags: ['Finance'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    await prisma.financeEntry.delete({ where: { id } });
    return { message: 'Deleted' };
  });
}
