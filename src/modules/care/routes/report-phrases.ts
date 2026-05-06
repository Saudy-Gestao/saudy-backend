import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function reportPhraseRoutes(app: FastifyInstance) {
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
      summary: 'List report phrases',
      tags: ['Report Phrases'],
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
        { label: { contains: search, mode: 'insensitive' } },
        { text: { contains: search, mode: 'insensitive' } },
        { examType: { contains: search, mode: 'insensitive' } },
        { shortcut: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.reportPhrase.findMany({ where, take: limit, skip: offset, orderBy: { createdAt: 'desc' } }),
      prisma.reportPhrase.count({ where }),
    ]);

    return { items, total };
  });

  app.post('/', {
    schema: {
      summary: 'Create report phrase',
      tags: ['Report Phrases'],
      body: {
        type: 'object',
        required: ['examType', 'label', 'text'],
        properties: {
          examType: { type: 'string', minLength: 1 },
          label: { type: 'string', minLength: 1 },
          shortcut: { type: 'string', minLength: 1, maxLength: 40 },
          text: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;

    if (!data.label || !String(data.label).trim()) {
      return reply.code(400).send({ error: 'label is required' });
    }
    if (!data.examType || !String(data.examType).trim()) {
      return reply.code(400).send({ error: 'examType is required' });
    }
    if (!data.text || !String(data.text).trim()) {
      return reply.code(400).send({ error: 'text is required' });
    }
    const shortcut = data.shortcut ? String(data.shortcut).trim() : null;

    try {
      const item = await prisma.reportPhrase.create({
        data: {
          branchId,
          examType: data.examType,
          label: data.label,
          shortcut,
          text: data.text,
        },
      });

      return reply.code(201).send(item);
    } catch (err: any) {
      request.log.error({ err }, 'Failed to create report phrase');
      return reply.code(400).send({ error: 'Failed to create report phrase', details: err.message });
    }
  });

  app.put('/:id', {
    schema: {
      summary: 'Update report phrase',
      tags: ['Report Phrases'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object' },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const data = request.body as any;
    const shortcut = data.shortcut === undefined
      ? undefined
      : (data.shortcut ? String(data.shortcut).trim() : null);

    try {
      const existing = await prisma.reportPhrase.findFirst({ where: { id, branchId } });
      if (!existing) return reply.code(404).send({ error: 'Report phrase not found' });

      const item = await prisma.reportPhrase.update({
        where: { id },
        data: {
          ...data,
          branchId,
          shortcut,
        },
      });
      return item;
    } catch (err: any) {
      request.log.error({ err }, 'Failed to update report phrase');
      return reply.code(400).send({ error: 'Failed to update report phrase', details: err.message });
    }
  });

  app.delete('/:id', {
    schema: {
      summary: 'Delete report phrase',
      tags: ['Report Phrases'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const existing = await prisma.reportPhrase.findFirst({ where: { id, branchId } });
    if (!existing) return reply.code(404).send({ error: 'Report phrase not found' });
    await prisma.reportPhrase.delete({ where: { id } });
    return { message: 'Deleted' };
  });
}
