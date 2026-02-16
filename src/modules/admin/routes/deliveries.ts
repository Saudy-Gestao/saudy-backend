import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function deliveryRoutes(app: FastifyInstance) {
  // List deliveries
  app.get('/', {
    schema: {
      summary: 'List deliveries',
      tags: ['Deliveries'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          status: { type: 'string' },
          documentType: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { search, status, documentType, limit = 50, offset = 0 } = request.query as any;

    const where: any = { isActive: true };
    if (status) where.status = status;
    if (documentType) where.documentType = documentType;
    if (search) where.OR = [
      { patientName: { contains: search, mode: 'insensitive' } },
      { deliveredTo: { contains: search, mode: 'insensitive' } },
      { responsible: { contains: search, mode: 'insensitive' } },
    ];

    const [items, total] = await Promise.all([
      prisma.delivery.findMany({ where, take: limit, skip: offset, orderBy: { availableAt: 'desc' } }),
      prisma.delivery.count({ where }),
    ]);

    return { items, total };
  });

  // Get by id
  app.get('/:id', {
    schema: {
      summary: 'Get delivery by ID',
      tags: ['Deliveries'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const item = await prisma.delivery.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: 'Delivery not found' });
    return item;
  });

  // Create
  app.post('/', {
    schema: {
      summary: 'Create delivery',
      tags: ['Deliveries'],
      body: { $ref: 'DeliveryCreate#' },
      response: { 201: { $ref: 'Delivery#' }, 400: { type: 'object', additionalProperties: true } },
    },
  }, async (request, reply) => {
    const data = request.body as any;

    try {
      const item = await prisma.delivery.create({ data: {
        patientName: data.patientName,
        documentType: data.documentType,
        availableAt: data.availableAt ? new Date(data.availableAt) : new Date(),
        description: data.description || null,
        responsible: data.responsible || null,
        status: data.status || 'DISPONIVEL',
        deliveredTo: data.deliveredTo || null,
        deliveredAt: data.deliveredAt ? new Date(data.deliveredAt) : null,
      } });

      return reply.code(201).send(item);
    } catch (err: any) {
      request.log.error({ err }, 'Failed to create delivery');
      return reply.code(400).send({ error: 'Failed to create delivery', details: err.message });
    }
  });

  // Update
  app.put('/:id', {
    schema: {
      summary: 'Update delivery',
      tags: ['Deliveries'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { $ref: 'DeliveryUpdate#' },
      response: { 200: { $ref: 'Delivery#' }, 400: { type: 'object', additionalProperties: true } },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const data = request.body as any;

    try {
      if (data.availableAt) data.availableAt = new Date(data.availableAt);
      if (data.deliveredAt) data.deliveredAt = new Date(data.deliveredAt);

      const item = await prisma.delivery.update({ where: { id }, data });
      return item;
    } catch (err: any) {
      request.log.error({ err }, 'Failed to update delivery');
      return reply.code(400).send({ error: 'Failed to update delivery', details: err.message });
    }
  });

  // Delete
  app.delete('/:id', {
    schema: {
      summary: 'Delete delivery',
      tags: ['Deliveries'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    await prisma.delivery.delete({ where: { id } });
    return { message: 'Deleted' };
  });
}
