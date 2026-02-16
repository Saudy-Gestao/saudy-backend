import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function appointmentRoutes(app: FastifyInstance) {
  app.get('/', {
    schema: {
      summary: 'List appointments',
      tags: ['Appointments'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          status: { type: 'string' },
          specialty: { type: 'string' },
          convenio: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request) => {
    const { search, status, specialty, convenio, limit = 50, offset = 0 } = request.query as any;

    const where: any = { isActive: true };
    if (status) where.status = status;
    if (specialty) where.specialty = specialty;
    if (convenio) where.convenio = convenio;
    if (search) {
      where.OR = [
        { patientName: { contains: search, mode: 'insensitive' } },
        { patientCpf: { contains: search, mode: 'insensitive' } },
        { doctorName: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.appointment.findMany({ where, take: limit, skip: offset, orderBy: { createdAt: 'desc' } }),
      prisma.appointment.count({ where }),
    ]);

    return { items, total };
  });

  app.get('/:id', {
    schema: {
      summary: 'Get appointment by ID',
      tags: ['Appointments'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const item = await prisma.appointment.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: 'Appointment not found' });
    return item;
  });

  app.post('/', {
    schema: {
      summary: 'Create appointment',
      tags: ['Appointments'],
      body: {
        type: 'object',
        required: ['specialty', 'date', 'time'],
        properties: {
          patientName: { type: 'string' },
          patientCpf: { type: 'string' },
          patientId: { type: 'string' },
          doctorName: { type: 'string' },
          specialty: { type: 'string' },
          convenio: { type: 'string' },
          date: { type: 'string' },
          time: { type: 'string' },
          type: { type: 'string' },
          status: { type: 'string' },
          observations: { type: 'string' },
          totem: { type: 'number' },
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
      const item = await prisma.appointment.create({ data: {
        patientName: data.patientName || null,
        patientCpf: data.patientCpf || null,
        patientId: data.patientId || null,
        doctorName: data.doctorName || null,
        specialty: data.specialty || null,
        convenio: data.convenio || null,
        date: data.date || null,
        time: data.time || null,
        type: data.type || null,
        status: data.status || null,
        observations: data.observations || null,
        totem: data.totem ?? null,
      } });

      return reply.code(201).send(item);
    } catch (err: any) {
      request.log.error({ err }, 'Failed to create appointment');
      return reply.code(400).send({ error: 'Failed to create appointment', details: err.message });
    }
  });

  app.put('/:id', {
    schema: {
      summary: 'Update appointment',
      tags: ['Appointments'],
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
      const existing = await prisma.appointment.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: 'Appointment not found' });

      const item = await prisma.appointment.update({ where: { id }, data });
      return item;
    } catch (err: any) {
      request.log.error({ err }, 'Failed to update appointment');
      return reply.code(400).send({ error: 'Failed to update appointment', details: err.message });
    }
  });

  app.delete('/:id', {
    schema: {
      summary: 'Delete appointment',
      tags: ['Appointments'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    await prisma.appointment.delete({ where: { id } });
    return { message: 'Deleted' };
  });
}
