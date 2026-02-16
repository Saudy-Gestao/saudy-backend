import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function appointmentRoutes(app: FastifyInstance) {
  // Auth hook for all routes in this plugin
  app.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // List appointments
  app.get('/', {
    schema: {
      summary: 'List appointments',
      tags: ['Appointments'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          doctorId: { type: 'string' },
          patientId: { type: 'string' },
          status: { type: 'string', enum: ['SCHEDULED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELED', 'NO_SHOW'] },
          type: { type: 'string', enum: ['CONSULTATION', 'RETURN', 'EXAM', 'PROCEDURE', 'EMERGENCY'] },
          startDate: { type: 'string', format: 'date' },
          endDate: { type: 'string', format: 'date' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            appointments: {
              type: 'array',
              items: { $ref: 'Appointment#' },
            },
            total: { type: 'number' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const {
      doctorId,
      patientId,
      status,
      type,
      startDate,
      endDate,
      limit = 50,
      offset = 0,
    } = request.query as {
      doctorId?: string;
      patientId?: string;
      status?: string;
      type?: string;
      startDate?: string;
      endDate?: string;
      limit?: number;
      offset?: number;
    };

    const where: any = {};

    if (doctorId) where.doctorId = doctorId;
    if (patientId) where.patientId = patientId;
    if (status) where.status = status;
    if (type) where.type = type;

    if (startDate || endDate) {
      where.scheduledAt = {};
      if (startDate) where.scheduledAt.gte = new Date(startDate);
      if (endDate) where.scheduledAt.lte = new Date(`${endDate}T23:59:59`);
    }

    const [appointments, total] = await Promise.all([
      prisma.appointment.findMany({
        where,
        include: {
          patient: {
            select: {
              id: true,
              name: true,
              cpf: true,
              cellphone: true,
              hasHealthInsurance: true,
              healthInsuranceName: true,
            },
          },
          doctor: {
            select: {
              id: true,
              name: true,
              crm: true,
              crmState: true,
              specialty: true,
            },
          },
        },
        orderBy: { scheduledAt: 'asc' },
        take: limit,
        skip: offset,
      }),
      prisma.appointment.count({ where }),
    ]);

    return { appointments, total };
  });

  // Get appointment by ID
  app.get('/:id', {
    schema: {
      summary: 'Get appointment by ID',
      tags: ['Appointments'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      response: {
        200: { $ref: 'Appointment#' },
        404: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const appointment = await prisma.appointment.findUnique({
      where: { id },
      include: {
        patient: true,
        doctor: true,
        medicalRecord: true,
      },
    });

    if (!appointment) {
      return reply.code(404).send({ error: 'Appointment not found' });
    }

    return appointment;
  });

  // Create new appointment
  app.post('/', {
    schema: {
      summary: 'Create a new appointment',
      tags: ['Appointments'],
      security: [{ bearerAuth: [] }],
      body: { $ref: 'AppointmentCreate#' },
      response: {
        201: { $ref: 'Appointment#' },
        400: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const data = request.body as {
      patientId: string;
      doctorId: string;
      scheduledAt: string;
      duration?: number;
      type?: string;
      reason?: string;
      notes?: string;
    };

    // Verify patient exists
    const patient = await prisma.patient.findUnique({ where: { id: data.patientId } });
    if (!patient) {
      return reply.code(400).send({ error: 'Patient not found' });
    }

    // Verify doctor exists
    const doctor = await prisma.doctor.findUnique({ where: { id: data.doctorId } });
    if (!doctor) {
      return reply.code(400).send({ error: 'Doctor not found' });
    }

    // Check for scheduling conflicts
    const scheduledAt = new Date(data.scheduledAt);
    const duration = data.duration || 30;
    const endTime = new Date(scheduledAt.getTime() + duration * 60000);

    const conflictingAppointment = await prisma.appointment.findFirst({
      where: {
        doctorId: data.doctorId,
        status: { in: ['SCHEDULED', 'CONFIRMED'] },
        scheduledAt: {
          lt: endTime,
        },
        AND: {
          scheduledAt: {
            gte: new Date(scheduledAt.getTime() - 30 * 60000), // 30 min before
          },
        },
      },
    });

    if (conflictingAppointment) {
      return reply.code(400).send({
        error: 'Scheduling conflict',
        details: 'There is already an appointment scheduled at this time for this doctor',
      });
    }

    try {
      const appointment = await prisma.appointment.create({
        data: {
          ...data,
          scheduledAt,
          duration,
        },
        include: {
          patient: {
            select: { id: true, name: true, cellphone: true },
          },
          doctor: {
            select: { id: true, name: true, specialty: true },
          },
        },
      });

      return reply.code(201).send(appointment);
    } catch (error: any) {
      return reply.code(400).send({ error: 'Failed to create appointment', details: error.message });
    }
  });

  // Update appointment
  app.put('/:id', {
    schema: {
      summary: 'Update an appointment',
      tags: ['Appointments'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      body: { $ref: 'AppointmentUpdate#' },
      response: {
        200: { $ref: 'Appointment#' },
        400: { type: 'object' },
        404: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = request.body as any;

    const existing = await prisma.appointment.findUnique({ where: { id } });

    if (!existing) {
      return reply.code(404).send({ error: 'Appointment not found' });
    }

    try {
      const updateData: any = { ...data };

      if (data.scheduledAt) {
        updateData.scheduledAt = new Date(data.scheduledAt);
      }

      // Handle status changes
      if (data.status === 'CONFIRMED' && existing.status === 'SCHEDULED') {
        updateData.confirmedAt = new Date();
      } else if (data.status === 'CANCELED') {
        updateData.canceledAt = new Date();
      } else if (data.status === 'COMPLETED') {
        updateData.completedAt = new Date();
      }

      const appointment = await prisma.appointment.update({
        where: { id },
        data: updateData,
        include: {
          patient: { select: { id: true, name: true, cellphone: true } },
          doctor: { select: { id: true, name: true, specialty: true } },
        },
      });

      return appointment;
    } catch (error: any) {
      return reply.code(400).send({ error: 'Failed to update appointment', details: error.message });
    }
  });

  // Cancel appointment
  app.post('/:id/cancel', {
    schema: {
      summary: 'Cancel an appointment',
      tags: ['Appointments'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      body: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
        },
      },
      response: {
        200: { $ref: 'Appointment#' },
        400: { type: 'object' },
        404: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reason } = request.body as { reason?: string };

    const existing = await prisma.appointment.findUnique({ where: { id } });

    if (!existing) {
      return reply.code(404).send({ error: 'Appointment not found' });
    }

    if (existing.status === 'CANCELED') {
      return reply.code(400).send({ error: 'Appointment is already canceled' });
    }

    if (existing.status === 'COMPLETED') {
      return reply.code(400).send({ error: 'Cannot cancel a completed appointment' });
    }

    const appointment = await prisma.appointment.update({
      where: { id },
      data: {
        status: 'CANCELED',
        canceledAt: new Date(),
        cancelReason: reason,
      },
    });

    return appointment;
  });

  // Confirm appointment
  app.post('/:id/confirm', {
    schema: {
      summary: 'Confirm an appointment',
      tags: ['Appointments'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      response: {
        200: { $ref: 'Appointment#' },
        400: { type: 'object' },
        404: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const existing = await prisma.appointment.findUnique({ where: { id } });

    if (!existing) {
      return reply.code(404).send({ error: 'Appointment not found' });
    }

    if (existing.status !== 'SCHEDULED') {
      return reply.code(400).send({ error: `Cannot confirm appointment with status ${existing.status}` });
    }

    const appointment = await prisma.appointment.update({
      where: { id },
      data: {
        status: 'CONFIRMED',
        confirmedAt: new Date(),
      },
    });

    return appointment;
  });

  // Delete appointment
  app.delete('/:id', {
    schema: {
      summary: 'Delete an appointment',
      tags: ['Appointments'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      response: {
        200: { type: 'object', properties: { message: { type: 'string' } } },
        400: { type: 'object' },
        404: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const existing = await prisma.appointment.findUnique({
      where: { id },
      include: { medicalRecord: true },
    });

    if (!existing) {
      return reply.code(404).send({ error: 'Appointment not found' });
    }

    if (existing.medicalRecord) {
      return reply.code(400).send({
        error: 'Cannot delete appointment',
        details: 'This appointment has a medical record associated. Delete the record first.',
      });
    }

    await prisma.appointment.delete({ where: { id } });

    return { message: 'Appointment deleted successfully' };
  });

  // Get today's appointments
  app.get('/today/all', {
    schema: {
      summary: 'Get all appointments for today',
      tags: ['Appointments'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'array',
          items: { $ref: 'Appointment#' },
        },
      },
    },
  }, async (request, reply) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const appointments = await prisma.appointment.findMany({
      where: {
        scheduledAt: {
          gte: today,
          lt: tomorrow,
        },
      },
      include: {
        patient: {
          select: { id: true, name: true, cellphone: true, hasHealthInsurance: true },
        },
        doctor: {
          select: { id: true, name: true, specialty: true },
        },
      },
      orderBy: { scheduledAt: 'asc' },
    });

    return appointments;
  });

  // Get appointment statistics
  app.get('/stats/overview', {
    schema: {
      summary: 'Get appointment statistics',
      tags: ['Appointments'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          startDate: { type: 'string', format: 'date' },
          endDate: { type: 'string', format: 'date' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            total: { type: 'number' },
            byStatus: { type: 'array' },
            byType: { type: 'array' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { startDate, endDate } = request.query as {
      startDate?: string;
      endDate?: string;
    };

    const where: any = {};
    if (startDate || endDate) {
      where.scheduledAt = {};
      if (startDate) where.scheduledAt.gte = new Date(startDate);
      if (endDate) where.scheduledAt.lte = new Date(`${endDate}T23:59:59`);
    }

    const [total, byStatus, byType] = await Promise.all([
      prisma.appointment.count({ where }),
      prisma.appointment.groupBy({
        by: ['status'],
        where,
        _count: { status: true },
      }),
      prisma.appointment.groupBy({
        by: ['type'],
        where,
        _count: { type: true },
      }),
    ]);

    return {
      total,
      byStatus: byStatus.map((s: { status: string; _count: { status: number } }) => ({ status: s.status, count: s._count.status })),
      byType: byType.map((t: { type: string; _count: { type: number } }) => ({ type: t.type, count: t._count.type })),
    };
  });
}
