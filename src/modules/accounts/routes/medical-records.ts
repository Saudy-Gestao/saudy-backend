import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function medicalRecordRoutes(app: FastifyInstance) {
  const getLoggedBranchId = async (request: any) => {
    const userId = (request.user as any)?.id;
    if (!userId) return null;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });
    return user?.sector?.branch?.id || null;
  };

  // Auth hook for all routes in this plugin
  app.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // List medical records
  app.get('/', {
    schema: {
      summary: 'List medical records',
      tags: ['Medical Records'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          patientId: { type: 'string' },
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
            records: {
              type: 'array',
              items: { $ref: 'MedicalRecord#' },
            },
            total: { type: 'number' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const {
      patientId,
      startDate,
      endDate,
      limit = 50,
      offset = 0,
    } = request.query as {
      patientId?: string;
      startDate?: string;
      endDate?: string;
      limit?: number;
      offset?: number;
    };

    const where: any = {
      patient: {
        branchId,
      },
    };

    if (patientId) where.patientId = patientId;

    if (startDate || endDate) {
      where.recordDate = {};
      if (startDate) where.recordDate.gte = new Date(startDate);
      if (endDate) where.recordDate.lte = new Date(`${endDate}T23:59:59`);
    }

    const [records, total] = await Promise.all([
      prisma.medicalRecord.findMany({
        where,
        include: {
          patient: {
            select: {
              id: true,
              name: true,
              cpf: true,
              birthDate: true,
              bloodType: true,
              allergies: true,
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
        orderBy: { recordDate: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.medicalRecord.count({ where }),
    ]);

    return { records, total };
  });

  // Get medical record by ID
  app.get('/:id', {
    schema: {
      summary: 'Get medical record by ID',
      tags: ['Medical Records'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      response: {
        200: { $ref: 'MedicalRecord#' },
        404: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as { id: string };

    const record = await prisma.medicalRecord.findFirst({
      where: {
        id,
        patient: { branchId },
      },
      include: {
        patient: true,
        doctor: true,
      },
    });

    if (!record) {
      return reply.code(404).send({ error: 'Medical record not found' });
    }

    return record;
  });

  // Create new medical record
  app.post('/', {
    schema: {
      summary: 'Create a new medical record',
      tags: ['Medical Records'],
      security: [{ bearerAuth: [] }],
      body: { $ref: 'MedicalRecordCreate#' },
      response: {
        201: { $ref: 'MedicalRecord#' },
        400: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;

    // Verify patient exists
    const patient = await prisma.patient.findFirst({ where: { id: data.patientId, branchId } });
    if (!patient) {
      return reply.code(400).send({ error: 'Patient not found' });
    }

    // Verify doctor exists if provided
    if (data.doctorId) {
      const doctor = await prisma.doctor.findFirst({ where: { id: data.doctorId, branchId } });
      if (!doctor) {
        return reply.code(400).send({ error: 'Doctor not found' });
      }
    }

    try {
      const record = await prisma.medicalRecord.create({
        data: {
          ...data,
          recordDate: data.recordDate ? new Date(data.recordDate) : new Date(),
        },
        include: {
          patient: {
            select: { id: true, name: true, cpf: true },
          },
          doctor: {
            select: { id: true, name: true, specialty: true },
          },
        },
      });

      return reply.code(201).send(record);
    } catch (error: any) {
      return reply.code(400).send({ error: 'Failed to create medical record', details: error.message });
    }
  });

  // Update medical record
  app.put('/:id', {
    schema: {
      summary: 'Update a medical record',
      tags: ['Medical Records'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      body: { $ref: 'MedicalRecordUpdate#' },
      response: {
        200: { $ref: 'MedicalRecord#' },
        400: { type: 'object' },
        404: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as { id: string };
    const data = request.body as any;

    const existing = await prisma.medicalRecord.findFirst({ where: { id, patient: { branchId } } });

    if (!existing) {
      return reply.code(404).send({ error: 'Medical record not found' });
    }

    try {
      const record = await prisma.medicalRecord.update({
        where: { id },
        data,
        include: {
          patient: {
            select: { id: true, name: true, cpf: true },
          },
          doctor: {
            select: { id: true, name: true, specialty: true },
          },
        },
      });

      return record;
    } catch (error: any) {
      return reply.code(400).send({ error: 'Failed to update medical record', details: error.message });
    }
  });

  // Delete medical record
  app.delete('/:id', {
    schema: {
      summary: 'Delete a medical record',
      tags: ['Medical Records'],
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
        404: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as { id: string };

    const existing = await prisma.medicalRecord.findFirst({ where: { id, patient: { branchId } } });

    if (!existing) {
      return reply.code(404).send({ error: 'Medical record not found' });
    }

    await prisma.medicalRecord.delete({ where: { id } });

    return { message: 'Medical record deleted successfully' };
  });

  // Get patient's latest vital signs
  app.get('/patient/:patientId/vitals', {
    schema: {
      summary: 'Get patient latest vital signs from medical records',
      tags: ['Medical Records'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          patientId: { type: 'string' },
        },
        required: ['patientId'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            latest: {
              type: 'object',
              properties: {
                bloodPressure: { type: 'string', nullable: true },
                heartRate: { type: 'number', nullable: true },
                temperature: { type: 'number', nullable: true },
                weight: { type: 'number', nullable: true },
                height: { type: 'number', nullable: true },
                recordDate: { type: 'string', format: 'date-time' },
              },
            },
            history: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  bloodPressure: { type: 'string', nullable: true },
                  heartRate: { type: 'number', nullable: true },
                  temperature: { type: 'number', nullable: true },
                  weight: { type: 'number', nullable: true },
                  height: { type: 'number', nullable: true },
                  recordDate: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        404: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { patientId } = request.params as { patientId: string };

    const patient = await prisma.patient.findFirst({ where: { id: patientId, branchId } });
    if (!patient) {
      return reply.code(404).send({ error: 'Patient not found' });
    }

    const records = await prisma.medicalRecord.findMany({
      where: {
        patientId,
        OR: [
          { bloodPressure: { not: null } },
          { heartRate: { not: null } },
          { temperature: { not: null } },
          { weight: { not: null } },
          { height: { not: null } },
        ],
      },
      select: {
        bloodPressure: true,
        heartRate: true,
        temperature: true,
        weight: true,
        height: true,
        recordDate: true,
      },
      orderBy: { recordDate: 'desc' },
      take: 10,
    });

    return {
      latest: records[0] || null,
      history: records,
    };
  });
}
