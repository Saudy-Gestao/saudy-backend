import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

const normalizeText = (value?: string) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .trim();

export default async function teaEvolutionTemplateRoutes(app: FastifyInstance) {
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

    const branchId = await getLoggedBranchId(request);
    if (!branchId) {
      return reply.code(403).send({ error: 'User not associated with a branch' });
    }

    (request as any).branchId = branchId;
  });

  app.get('/', {
    schema: {
      summary: 'List TEA evolution templates',
      tags: ['TeaEvolutionTemplates'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          procedureId: { type: 'string' },
          isActive: { type: 'boolean' },
          limit: { type: 'number', default: 100 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request) => {
    const branchId = (request as any).branchId as string;
    const { search, procedureId, isActive, limit = 100, offset = 0 } = request.query as any;

    const where: any = { branchId };
    if (typeof isActive === 'boolean') where.isActive = isActive;
    if (procedureId) where.procedureId = String(procedureId);
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { procedure: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.teaEvolutionTemplate.findMany({
        where,
        include: {
          procedure: { select: { id: true, name: true, durationMinutes: true } },
        },
        orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
        take: Number(limit),
        skip: Number(offset),
      }),
      prisma.teaEvolutionTemplate.count({ where }),
    ]);

    return { items, total };
  });

  app.get('/resolve', {
    schema: {
      summary: 'Resolve active template by procedure',
      tags: ['TeaEvolutionTemplates'],
      querystring: {
        type: 'object',
        properties: {
          procedureId: { type: 'string' },
          procedureName: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = (request as any).branchId as string;
    const { procedureId, procedureName } = request.query as { procedureId?: string; procedureName?: string };

    if (!procedureId && !procedureName) {
      return reply.code(400).send({ error: 'Inform procedureId or procedureName' });
    }

    let resolvedProcedureId = procedureId ? String(procedureId) : '';

    if (!resolvedProcedureId && procedureName) {
      const normalized = normalizeText(procedureName);
      const procedures = await prisma.procedure.findMany({
        where: { branchId, isActive: true },
        select: { id: true, name: true },
      });
      const matched = procedures.find((item: { id: string; name: string }) => normalizeText(item.name) === normalized)
        || procedures.find((item: { id: string; name: string }) => normalizeText(item.name).includes(normalized) || normalized.includes(normalizeText(item.name)));
      resolvedProcedureId = matched?.id || '';
    }

    if (!resolvedProcedureId) return { item: null };

    const item = await prisma.teaEvolutionTemplate.findFirst({
      where: { branchId, procedureId: resolvedProcedureId, isActive: true },
      include: {
        procedure: { select: { id: true, name: true, durationMinutes: true } },
      },
    });

    return { item: item || null };
  });

  app.post('/', {
    schema: {
      summary: 'Create or update TEA evolution template',
      tags: ['TeaEvolutionTemplates'],
      body: {
        type: 'object',
        required: ['procedureId'],
        properties: {
          procedureId: { type: 'string' },
          name: { type: 'string' },
          sessionGoal: { type: 'string' },
          interventionSummary: { type: 'string' },
          patientResponse: { type: 'string' },
          familyFeedback: { type: 'string' },
          homePlan: { type: 'string' },
          strategiesUsed: { type: 'array', items: { type: 'string' } },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = (request as any).branchId as string;
    const data = request.body as any;

    const procedure = await prisma.procedure.findFirst({
      where: { id: String(data.procedureId), branchId, isActive: true },
      select: { id: true, name: true },
    });
    if (!procedure) return reply.code(400).send({ error: 'Invalid procedure for this branch' });

    const strategies = Array.isArray(data.strategiesUsed)
      ? data.strategiesUsed.map((item: unknown) => String(item || '').trim()).filter(Boolean)
      : [];

    const item = await prisma.teaEvolutionTemplate.upsert({
      where: {
        branchId_procedureId: {
          branchId,
          procedureId: procedure.id,
        },
      },
      update: {
        name: data.name || null,
        sessionGoal: data.sessionGoal || null,
        interventionSummary: data.interventionSummary || null,
        patientResponse: data.patientResponse || null,
        familyFeedback: data.familyFeedback || null,
        homePlan: data.homePlan || null,
        strategiesUsed: strategies,
        isActive: data.isActive ?? true,
      },
      create: {
        branchId,
        procedureId: procedure.id,
        name: data.name || null,
        sessionGoal: data.sessionGoal || null,
        interventionSummary: data.interventionSummary || null,
        patientResponse: data.patientResponse || null,
        familyFeedback: data.familyFeedback || null,
        homePlan: data.homePlan || null,
        strategiesUsed: strategies,
        isActive: data.isActive ?? true,
      },
      include: {
        procedure: { select: { id: true, name: true, durationMinutes: true } },
      },
    });

    return reply.code(201).send(item);
  });

  app.put('/:id', {
    schema: {
      summary: 'Update TEA evolution template',
      tags: ['TeaEvolutionTemplates'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          sessionGoal: { type: 'string' },
          interventionSummary: { type: 'string' },
          patientResponse: { type: 'string' },
          familyFeedback: { type: 'string' },
          homePlan: { type: 'string' },
          strategiesUsed: { type: 'array', items: { type: 'string' } },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = (request as any).branchId as string;
    const { id } = request.params as { id: string };
    const data = request.body as any;

    const existing = await prisma.teaEvolutionTemplate.findFirst({ where: { id, branchId } });
    if (!existing) return reply.code(404).send({ error: 'Template not found' });

    const item = await prisma.teaEvolutionTemplate.update({
      where: { id },
      data: {
        name: data.name ?? existing.name,
        sessionGoal: data.sessionGoal ?? existing.sessionGoal,
        interventionSummary: data.interventionSummary ?? existing.interventionSummary,
        patientResponse: data.patientResponse ?? existing.patientResponse,
        familyFeedback: data.familyFeedback ?? existing.familyFeedback,
        homePlan: data.homePlan ?? existing.homePlan,
        strategiesUsed: Array.isArray(data.strategiesUsed)
          ? data.strategiesUsed.map((item: unknown) => String(item || '').trim()).filter(Boolean)
          : existing.strategiesUsed,
        isActive: typeof data.isActive === 'boolean' ? data.isActive : existing.isActive,
      },
      include: {
        procedure: { select: { id: true, name: true, durationMinutes: true } },
      },
    });

    return item;
  });

  app.delete('/:id', {
    schema: {
      summary: 'Deactivate TEA evolution template',
      tags: ['TeaEvolutionTemplates'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const branchId = (request as any).branchId as string;
    const { id } = request.params as { id: string };

    const existing = await prisma.teaEvolutionTemplate.findFirst({ where: { id, branchId } });
    if (!existing) return reply.code(404).send({ error: 'Template not found' });

    await prisma.teaEvolutionTemplate.update({ where: { id }, data: { isActive: false } });
    return { message: 'Template deactivated' };
  });
}
