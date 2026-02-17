import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function reportRoutes(app: FastifyInstance) {
  app.get('/', {
    schema: {
      summary: 'List reports',
      tags: ['Reports'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          status: { type: 'string' },
          exam: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request) => {
    const { search, status, exam, limit = 50, offset = 0 } = request.query as any;

    const where: any = { isActive: true };
    if (status) where.status = status;
    if (exam) where.exam = exam;
    if (search) {
      where.OR = [
        { patientName: { contains: search, mode: 'insensitive' } },
        { cpf: { contains: search, mode: 'insensitive' } },
        { requestingDoctor: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.report.findMany({ where, take: limit, skip: offset, orderBy: { createdAt: 'desc' } }),
      prisma.report.count({ where }),
    ]);

    return { items, total };
  });

  app.get('/:id', {
    schema: {
      summary: 'Get report by ID',
      tags: ['Reports'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const item = await prisma.report.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: 'Report not found' });
    return item;
  });

  app.post('/', {
    schema: {
      summary: 'Create report',
      tags: ['Reports'],
      body: {
        type: 'object',
        required: ['patientName'],
        properties: {
          patientName: { type: 'string', minLength: 1 },
          cpf: { type: 'string', pattern: '^\\d{11}$' },
          birthDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          requestingDoctor: { type: 'string' },
          reportingDoctor: { type: 'string' },
          reviewingDoctor: { type: 'string' },
          description: { type: 'string' },
          conclusion: { type: 'string' },
          notes: { type: 'string' },
          status: { type: 'string' },
          exam: { type: 'string' },
          scheduledFor: { type: 'string' },
          responsibleDoctor: { type: 'string' },
          observation: { type: 'string' },
        },
      },
      response: {
        201: { type: 'object' },
        400: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const data = request.body as any;

    // runtime validations (complement AJV schema): trim checks and clearer error messages
    if (!data.patientName || !String(data.patientName).trim()) {
      return reply.code(400).send({ error: 'patientName is required' });
    }

    if (data.cpf) {
      const digits = String(data.cpf).replace(/\D/g, '');
      if (digits.length !== 11) {
        return reply.code(400).send({ error: 'cpf must contain 11 digits' });
      }
      data.cpf = digits; // normalize
    }

    if (data.birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(data.birthDate))) {
      return reply.code(400).send({ error: 'birthDate must be YYYY-MM-DD' });
    }

    try {
      const item = await prisma.report.create({ data: {
        patientName: data.patientName,
        cpf: data.cpf || null,
        birthDate: data.birthDate || null,
        requestingDoctor: data.requestingDoctor || null,
        reportingDoctor: data.reportingDoctor || null,
        reviewingDoctor: data.reviewingDoctor || null,
        description: data.description || null,
        conclusion: data.conclusion || null,
        notes: data.notes || null,
        status: data.status || null,
        exam: data.exam || null,
        scheduledFor: data.scheduledFor || null,
        responsibleDoctor: data.responsibleDoctor || null,
        observation: data.observation || null,
      } });

      return reply.code(201).send(item);
    } catch (err: any) {
      request.log.error({ err }, 'Failed to create report');
      return reply.code(400).send({ error: 'Failed to create report', details: err.message });
    }
  });

  app.put('/:id', {
    schema: {
      summary: 'Update report',
      tags: ['Reports'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        properties: {
          patientName: { type: 'string', minLength: 1 },
          cpf: { type: 'string', pattern: '^\\d{11}$' },
          birthDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          requestingDoctor: { type: 'string' },
          reportingDoctor: { type: 'string' },
          reviewingDoctor: { type: 'string' },
          description: { type: 'string' },
          conclusion: { type: 'string' },
          notes: { type: 'string' },
          status: { type: 'string' },
          exam: { type: 'string' },
          scheduledFor: { type: 'string' },
          responsibleDoctor: { type: 'string' },
          observation: { type: 'string' },
        },
      },
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
      const existing = await prisma.report.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: 'Report not found' });

      // runtime validations for update
      if (data.patientName !== undefined && (!String(data.patientName).trim())) {
        return reply.code(400).send({ error: 'patientName cannot be empty' });
      }

      if (data.cpf) {
        const digits = String(data.cpf).replace(/\D/g, '');
        if (digits.length !== 11) {
          return reply.code(400).send({ error: 'cpf must contain 11 digits' });
        }
        data.cpf = digits;
      }

      if (data.birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(data.birthDate))) {
        return reply.code(400).send({ error: 'birthDate must be YYYY-MM-DD' });
      }

      const item = await prisma.report.update({ where: { id }, data });
      return item;
    } catch (err: any) {
      request.log.error({ err }, 'Failed to update report');
      return reply.code(400).send({ error: 'Failed to update report', details: err.message });
    }
  });

  app.delete('/:id', {
    schema: {
      summary: 'Delete report',
      tags: ['Reports'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    await prisma.report.delete({ where: { id } });
    return { message: 'Deleted' };
  });
}
