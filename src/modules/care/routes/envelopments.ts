import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function envelopmentRoutes(app: FastifyInstance) {
  app.get('/', {
    schema: {
      summary: 'List envelopments',
      tags: ['Envelopments'],
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
  }, async (request) => {
    const { search, status, documentType, limit = 50, offset = 0 } = request.query as any;

    const where: any = { isActive: true };
    if (status) where.status = status;
    if (documentType) where.documentType = documentType;
    if (search) {
      where.OR = [
        { patientName: { contains: search, mode: 'insensitive' } },
        { responsible: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.envelopment.findMany({ where, take: limit, skip: offset, orderBy: { createdAt: 'desc' } }),
      prisma.envelopment.count({ where }),
    ]);

    return { items, total };
  });

  app.get('/:id', {
    schema: {
      summary: 'Get envelopment by ID',
      tags: ['Envelopments'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const item = await prisma.envelopment.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: 'Envelopment not found' });
    return item;
  });

  app.post('/', {
    schema: {
      summary: 'Create envelopment',
      tags: ['Envelopments'],
      body: {
        type: 'object',
        required: ['patientName'],
        properties: {
          patientName: { type: 'string' },
          dateTime: { type: 'string' },
          responsible: { type: 'string' },
          status: { type: 'string' },
          pages: { type: 'number' },
          documentType: { type: 'string' },
          description: { type: 'string' },
          fileName: { type: 'string' },
          fileUrl: { type: 'string' },
        },
      },
      response: {
        201: { type: 'object' },
        400: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const data = request.body as any;
    try {
      const item = await prisma.envelopment.create({ data: {
        patientName: data.patientName,
        dateTime: data.dateTime || null,
        responsible: data.responsible || null,
        status: data.status || null,
        pages: data.pages ?? null,
        documentType: data.documentType || null,
        description: data.description || null,
        fileName: data.fileName || null,
        fileUrl: data.fileUrl || null,
      } });

      return reply.code(201).send(item);
    } catch (err: any) {
      request.log.error({ err }, 'Failed to create envelopment');
      return reply.code(400).send({ error: 'Failed to create envelopment', details: err.message });
    }
  });

  app.put('/:id', {
    schema: {
      summary: 'Update envelopment',
      tags: ['Envelopments'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object' },
      response: {
        200: { type: 'object' },
        400: { type: 'object', additionalProperties: true },
        404: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const data = request.body as any;

    try {
      const existing = await prisma.envelopment.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: 'Envelopment not found' });

      const item = await prisma.envelopment.update({ where: { id }, data });
      return item;
    } catch (err: any) {
      request.log.error({ err }, 'Failed to update envelopment');
      return reply.code(400).send({ error: 'Failed to update envelopment', details: err.message });
    }
  });

  app.delete('/:id', {
    schema: {
      summary: 'Delete envelopment',
      tags: ['Envelopments'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    await prisma.envelopment.delete({ where: { id } });
    return { message: 'Deleted' };
  });
}
