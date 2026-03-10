import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function reportTemplateRoutes(app: FastifyInstance) {
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
      summary: 'List report templates',
      tags: ['Report Templates'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          examType: { type: 'string' },
          limit: { type: 'number', default: 200 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { search, examType, limit = 200, offset = 0 } = request.query as any;

    const where: any = { isActive: true, branchId };
    if (examType) where.examType = examType;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { examType: { contains: search, mode: 'insensitive' } },
        { group: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.reportTemplate.findMany({ where, take: limit, skip: offset, orderBy: { createdAt: 'desc' } }),
      prisma.reportTemplate.count({ where }),
    ]);

    return { items, total };
  });

  app.post('/', {
    schema: {
      summary: 'Create report template',
      tags: ['Report Templates'],
      body: {
        type: 'object',
        required: ['name', 'examType', 'content'],
        properties: {
          name: { type: 'string', minLength: 1 },
          examType: { type: 'string', minLength: 1 },
          group: { type: 'string' },
          content: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;

    if (!data.name || !String(data.name).trim()) {
      return reply.code(400).send({ error: 'name is required' });
    }
    if (!data.examType || !String(data.examType).trim()) {
      return reply.code(400).send({ error: 'examType is required' });
    }
    if (!data.content || !String(data.content).trim()) {
      return reply.code(400).send({ error: 'content is required' });
    }

    try {
      const item = await prisma.reportTemplate.create({
        data: {
          branchId,
          name: data.name,
          examType: data.examType,
          group: data.group || null,
          content: data.content,
        },
      });

      return reply.code(201).send(item);
    } catch (err: any) {
      request.log.error({ err }, 'Failed to create report template');
      return reply.code(400).send({ error: 'Failed to create report template', details: err.message });
    }
  });

  app.put('/:id', {
    schema: {
      summary: 'Update report template',
      tags: ['Report Templates'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object' },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const data = request.body as any;

    try {
      const existing = await prisma.reportTemplate.findFirst({ where: { id, branchId } });
      if (!existing) return reply.code(404).send({ error: 'Report template not found' });

      const item = await prisma.reportTemplate.update({ where: { id }, data: { ...data, branchId } });
      return item;
    } catch (err: any) {
      request.log.error({ err }, 'Failed to update report template');
      return reply.code(400).send({ error: 'Failed to update report template', details: err.message });
    }
  });

  app.delete('/:id', {
    schema: {
      summary: 'Delete report template',
      tags: ['Report Templates'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const existing = await prisma.reportTemplate.findFirst({ where: { id, branchId } });
    if (!existing) return reply.code(404).send({ error: 'Report template not found' });
    await prisma.reportTemplate.delete({ where: { id } });
    return { message: 'Deleted' };
  });
}
