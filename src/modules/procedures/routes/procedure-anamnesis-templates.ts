import { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';

const QUESTION_TYPES = new Set([
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'DATE',
  'TIME',
  'DATETIME',
  'BOOLEAN',
  'SINGLE_CHOICE',
  'MULTIPLE_CHOICE',
]);

const normalizeQuestions = (questions: unknown) => {
  if (!Array.isArray(questions)) return [];

  return questions
    .map((question: any, index: number) => {
      const label = String(question?.label || '').trim();
      const responseType = String(question?.responseType || 'TEXT').trim().toUpperCase();
      if (!label || !QUESTION_TYPES.has(responseType)) return null;

      const options = Array.isArray(question?.options)
        ? question.options
            .map((option: any, optionIndex: number) => {
              const optionLabel = String(option?.label || '').trim();
              if (!optionLabel) return null;
              return {
                label: optionLabel,
                value: String(option?.value || optionLabel).trim() || optionLabel,
                orderIndex: Number.isFinite(Number(option?.orderIndex)) ? Number(option.orderIndex) : optionIndex,
              };
            })
            .filter(Boolean)
        : [];

      return {
        label,
        helpText: question?.helpText ? String(question.helpText) : null,
        responseType,
        placeholder: question?.placeholder ? String(question.placeholder) : null,
        isRequired: Boolean(question?.isRequired),
        orderIndex: Number.isFinite(Number(question?.orderIndex)) ? Number(question.orderIndex) : index,
        options,
      };
    })
    .filter(Boolean) as Array<{
      label: string;
      helpText: string | null;
      responseType: string;
      placeholder: string | null;
      isRequired: boolean;
      orderIndex: number;
      options: Array<{ label: string; value: string; orderIndex: number }>;
    }>;
};

const sortTemplate = (item: any) => ({
  ...item,
  questions: (item?.questions || [])
    .slice()
    .sort((a: any, b: any) => Number(a.orderIndex || 0) - Number(b.orderIndex || 0))
    .map((question: any) => ({
      ...question,
      options: (question?.options || [])
        .slice()
        .sort((a: any, b: any) => Number(a.orderIndex || 0) - Number(b.orderIndex || 0)),
    })),
});

export default async function procedureAnamnesisTemplateRoutes(app: FastifyInstance) {
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
      summary: 'List procedure anamnesis templates',
      tags: ['ProcedureAnamnesisTemplates'],
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
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { search, procedureId, isActive, limit = 100, offset = 0 } = request.query as any;
    const where: any = { branchId };
    if (procedureId) where.procedureId = String(procedureId);
    if (isActive !== undefined) where.isActive = Boolean(isActive);
    if (search) {
      where.OR = [
        { name: { contains: String(search), mode: 'insensitive' } },
        { description: { contains: String(search), mode: 'insensitive' } },
        { procedure: { name: { contains: String(search), mode: 'insensitive' } } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.procedureAnamnesisTemplate.findMany({
        where,
        take: Number(limit),
        skip: Number(offset),
        orderBy: { updatedAt: 'desc' },
        include: {
          procedure: { select: { id: true, name: true } },
          questions: {
            include: {
              options: true,
            },
          },
        },
      }),
      prisma.procedureAnamnesisTemplate.count({ where }),
    ]);

    return {
      total,
      items: items.map(sortTemplate),
    };
  });

  app.get('/:id', {
    schema: {
      summary: 'Get procedure anamnesis template by ID',
      tags: ['ProcedureAnamnesisTemplates'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const item = await prisma.procedureAnamnesisTemplate.findFirst({
      where: { id, branchId },
      include: {
        procedure: { select: { id: true, name: true } },
        questions: {
          include: {
            options: true,
          },
        },
      },
    });

    if (!item) return reply.code(404).send({ error: 'Procedure anamnesis template not found' });
    return sortTemplate(item);
  });

  app.post('/', {
    schema: {
      summary: 'Create procedure anamnesis template',
      tags: ['ProcedureAnamnesisTemplates'],
      body: {
        type: 'object',
        required: ['procedureId', 'name'],
        properties: {
          procedureId: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          isActive: { type: 'boolean' },
          questions: { type: 'array' },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;
    const procedureId = String(data?.procedureId || '').trim();
    const name = String(data?.name || '').trim();
    const questions = normalizeQuestions(data?.questions);

    if (!procedureId || !name) {
      return reply.code(400).send({ error: 'procedureId and name are required' });
    }

    const procedure = await prisma.procedure.findFirst({
      where: { id: procedureId, branchId },
      select: { id: true },
    });
    if (!procedure) return reply.code(404).send({ error: 'Procedure not found' });

    const existing = await prisma.procedureAnamnesisTemplate.findFirst({
      where: { branchId, procedureId },
      select: { id: true },
    });
    if (existing) {
      return reply.code(400).send({ error: 'Já existe uma anamnese cadastrada para este procedimento' });
    }

    const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const template = await tx.procedureAnamnesisTemplate.create({
        data: {
          branchId,
          procedureId,
          name,
          description: data?.description ? String(data.description) : null,
          isActive: data?.isActive !== undefined ? Boolean(data.isActive) : true,
        },
      });

      for (const question of questions) {
        const createdQuestion = await tx.procedureAnamnesisQuestion.create({
          data: {
            templateId: template.id,
            label: question.label,
            helpText: question.helpText,
            responseType: question.responseType,
            placeholder: question.placeholder,
            isRequired: question.isRequired,
            orderIndex: question.orderIndex,
          },
        });

        if (question.options.length > 0) {
          await tx.procedureAnamnesisQuestionOption.createMany({
            data: question.options.map((option) => ({
              questionId: createdQuestion.id,
              label: option.label,
              value: option.value,
              orderIndex: option.orderIndex,
            })),
          });
        }
      }

      return tx.procedureAnamnesisTemplate.findUnique({
        where: { id: template.id },
        include: {
          procedure: { select: { id: true, name: true } },
          questions: { include: { options: true } },
        },
      });
    });

    return reply.code(201).send(sortTemplate(created));
  });

  app.put('/:id', {
    schema: {
      summary: 'Update procedure anamnesis template',
      tags: ['ProcedureAnamnesisTemplates'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object' },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const data = request.body as any;
    const questions = data?.questions !== undefined ? normalizeQuestions(data.questions) : null;

    const existing = await prisma.procedureAnamnesisTemplate.findFirst({
      where: { id, branchId },
      select: { id: true, procedureId: true },
    });
    if (!existing) return reply.code(404).send({ error: 'Procedure anamnesis template not found' });

    const nextProcedureId = data?.procedureId ? String(data.procedureId).trim() : existing.procedureId;
    const procedure = await prisma.procedure.findFirst({
      where: { id: nextProcedureId, branchId },
      select: { id: true },
    });
    if (!procedure) return reply.code(404).send({ error: 'Procedure not found' });

    const duplicate = await prisma.procedureAnamnesisTemplate.findFirst({
      where: {
        branchId,
        procedureId: nextProcedureId,
        id: { not: id },
      },
      select: { id: true },
    });
    if (duplicate) {
      return reply.code(400).send({ error: 'Já existe uma anamnese cadastrada para este procedimento' });
    }

    const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.procedureAnamnesisTemplate.update({
        where: { id },
        data: {
          procedureId: nextProcedureId,
          ...(data?.name !== undefined ? { name: String(data.name || '').trim() } : {}),
          ...(data?.description !== undefined ? { description: data.description ? String(data.description) : null } : {}),
          ...(data?.isActive !== undefined ? { isActive: Boolean(data.isActive) } : {}),
        },
      });

      if (questions) {
        await tx.procedureAnamnesisQuestionOption.deleteMany({
          where: {
            question: {
              templateId: id,
            },
          },
        });
        await tx.procedureAnamnesisQuestion.deleteMany({
          where: { templateId: id },
        });

        for (const question of questions) {
          const createdQuestion = await tx.procedureAnamnesisQuestion.create({
            data: {
              templateId: id,
              label: question.label,
              helpText: question.helpText,
              responseType: question.responseType,
              placeholder: question.placeholder,
              isRequired: question.isRequired,
              orderIndex: question.orderIndex,
            },
          });

          if (question.options.length > 0) {
            await tx.procedureAnamnesisQuestionOption.createMany({
              data: question.options.map((option) => ({
                questionId: createdQuestion.id,
                label: option.label,
                value: option.value,
                orderIndex: option.orderIndex,
              })),
            });
          }
        }
      }

      return tx.procedureAnamnesisTemplate.findUnique({
        where: { id },
        include: {
          procedure: { select: { id: true, name: true } },
          questions: { include: { options: true } },
        },
      });
    });

    return sortTemplate(updated);
  });

  app.delete('/:id', {
    schema: {
      summary: 'Deactivate procedure anamnesis template',
      tags: ['ProcedureAnamnesisTemplates'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const existing = await prisma.procedureAnamnesisTemplate.findFirst({
      where: { id, branchId },
      select: { id: true },
    });
    if (!existing) return reply.code(404).send({ error: 'Procedure anamnesis template not found' });

    await prisma.procedureAnamnesisTemplate.update({
      where: { id },
      data: { isActive: false },
    });

    return { success: true };
  });
}
