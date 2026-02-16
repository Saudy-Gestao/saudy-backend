import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function patientRoutes(app: FastifyInstance) {
  // Auth hook for all routes in this plugin
  // Allow unauthenticated POST and GET to /patients (public create + read)
  app.addHook('onRequest', async (request, reply) => {
    const url = (request.raw && request.raw.url) ? request.raw.url : '';
    const isPublicCreate = request.method === 'POST' && /\/patients\/?(\?.*)?$/.test(url);
    const isPublicRead = request.method === 'GET' && /\/patients(\/.*)?(\?.*)?$/.test(url);
    if (isPublicCreate || isPublicRead) return;

    try {
      await request.jwtVerify();
    } catch (err) {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // List all patients
  app.get('/', {
    schema: {
      summary: 'List all patients',
      tags: ['Patients'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          isActive: { type: 'boolean' },
          search: { type: 'string' },
          hasHealthInsurance: { type: 'boolean' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            patients: {
              type: 'array',
              items: { $ref: 'Patient#' },
            },
            total: { type: 'number' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const {
      isActive,
      search,
      hasHealthInsurance,
      limit = 50,
      offset = 0,
    } = request.query as {
      isActive?: boolean;
      search?: string;
      hasHealthInsurance?: boolean;
      limit?: number;
      offset?: number;
    };

    const where: any = {};

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    if (hasHealthInsurance !== undefined) {
      where.hasHealthInsurance = hasHealthInsurance;
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { cpf: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { cellphone: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [patients, total] = await Promise.all([
      prisma.patient.findMany({
        where,
        orderBy: { name: 'asc' },
        take: limit,
        skip: offset,
      }),
      prisma.patient.count({ where }),
    ]);

    return { patients, total };
  });

  // Get patient by ID
  app.get('/:id', {
    schema: {
      summary: 'Get patient by ID',
      tags: ['Patients'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      response: {
        200: { $ref: 'Patient#' },
        404: {
          type: 'object',
          properties: { error: { type: 'string' } },
          additionalProperties: true,
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const patient = await prisma.patient.findUnique({
      where: { id },
    });

    if (!patient) {
      return reply.code(404).send({ error: 'Patient not found' });
    }

    return patient;
  });

  // Get patient by CPF
  app.get('/cpf/:cpf', {
    schema: {
      summary: 'Get patient by CPF',
      tags: ['Patients'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          cpf: { type: 'string' },
        },
        required: ['cpf'],
      },
      response: {
        200: { $ref: 'Patient#' },
        404: {
          type: 'object',
          properties: { error: { type: 'string' } },
          additionalProperties: true,
        },
      },
    },
  }, async (request, reply) => {
    const { cpf } = request.params as { cpf: string };

    const patient = await prisma.patient.findUnique({
      where: { cpf },
    });

    if (!patient) {
      return reply.code(404).send({ error: 'Patient not found' });
    }

    return patient;
  });

  // Create new patient
  app.post('/', {
    schema: {
      summary: 'Create a new patient',
      tags: ['Patients'],
      security: [{ bearerAuth: [] }],
      // body schema temporarily removed to diagnose client 400 errors
      response: {
        201: { $ref: 'Patient#' },
        400: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const data = request.body as any;

    // Explicit check for empty or missing parsed body
    if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
      request.log.warn({ body: data }, 'Empty or missing request body for patient create');
      return reply.code(400).send({ error: 'Bad Request', details: 'Request body is empty or could not be parsed as JSON. Ensure Content-Type: application/json and valid JSON body.' });
    }

    // Server-side field validation
    const fieldErrors: Record<string,string> = {};
    if (!data?.name || String(data.name).trim() === '') fieldErrors.name = 'Nome é obrigatório';
    if (!data?.cpf || !/^\d{11}$/.test(String(data.cpf))) fieldErrors.cpf = 'CPF deve conter 11 dígitos numéricos';
    if (!data?.birthDate || isNaN(Date.parse(String(data.birthDate)))) fieldErrors.birthDate = 'Data de nascimento inválida';
    else if (new Date(String(data.birthDate)) > new Date()) fieldErrors.birthDate = 'Data de nascimento inválida';
    // gender is required and must be one of allowed enums
    if (!data?.gender) fieldErrors.gender = 'Gênero é obrigatório';
    else if (!['MALE','FEMALE','OTHER'].includes(String(data.gender).toUpperCase())) fieldErrors.gender = 'Gênero inválido';
    if (data?.email !== undefined && data.email && !/^[\w-.]+@[\w-]+\.[\w-.]+$/.test(String(data.email))) fieldErrors.email = 'Email inválido';
    if (data?.hasHealthInsurance && !data?.healthInsuranceName) fieldErrors.healthInsuranceName = 'Nome do convênio é obrigatório';

    // Celular obrigatório + formato (10 ou 11 dígitos)
    if (!data?.cellphone) fieldErrors.cellphone = 'Celular é obrigatório';
    else if (!/^\d{10,11}$/.test(String(data.cellphone))) fieldErrors.cellphone = 'Celular inválido';

    if (Object.keys(fieldErrors).length > 0) {
      return reply.code(400).send({ error: 'Validation failed', fields: fieldErrors });
    }

    try {
      const patient = await prisma.patient.create({
        data: {
          ...data,
          birthDate: new Date(data.birthDate),
          healthInsuranceExpiry: data.healthInsuranceExpiry ? new Date(data.healthInsuranceExpiry) : null,
          allergies: data.allergies || [],
          chronicConditions: data.chronicConditions || [],
          currentMedications: data.currentMedications || [],
        },
      });

      return reply.code(201).send(patient);
    } catch (error: any) {
      request.log.error({ err: error }, 'Failed to create patient');
      if (error.code === 'P2002') {
        const field = error.meta?.target?.[0];
        return reply.code(400).send({ error: 'Validation failed', fields: { [field]: `${field} já existe` } });
      }
      return reply.code(400).send({ error: 'Failed to create patient', details: error.message });
    }
  });

  // Update patient
  app.put('/:id', {
    schema: {
      summary: 'Update a patient',
      tags: ['Patients'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      body: { $ref: 'PatientUpdate#' },
      response: {
        200: { $ref: 'Patient#' },
        400: {
          type: 'object',
          properties: { error: { type: 'string' }, details: { type: 'string' } },
          additionalProperties: true,
        },
        404: {
          type: 'object',
          properties: { error: { type: 'string' } },
          additionalProperties: true,
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = request.body as any;

    const existing = await prisma.patient.findUnique({ where: { id } });

    if (!existing) {
      return reply.code(404).send({ error: 'Patient not found' });
    }

    try {
      // validate provided fields on update
      const fieldErrors: Record<string,string> = {};
      if (data?.email !== undefined && data.email && !/^[\w-.]+@[\w-]+\.[\w-.]+$/.test(String(data.email))) fieldErrors.email = 'Email inválido';
      if (data?.cpf !== undefined && data.cpf && !/^\d{11}$/.test(String(data.cpf))) fieldErrors.cpf = 'CPF deve conter 11 dígitos numéricos';
      if (data?.birthDate !== undefined && data.birthDate && (isNaN(Date.parse(String(data.birthDate))) || new Date(String(data.birthDate)) > new Date())) fieldErrors.birthDate = 'Data de nascimento inválida';
      if (data?.hasHealthInsurance && data.hasHealthInsurance && !data?.healthInsuranceName) fieldErrors.healthInsuranceName = 'Nome do convênio é obrigatório';

      // cellphone: if provided on update, must be present and valid
      if (data?.cellphone !== undefined) {
        if (!data.cellphone) fieldErrors.cellphone = 'Celular é obrigatório';
        else if (!/^\d{10,11}$/.test(String(data.cellphone))) fieldErrors.cellphone = 'Celular inválido';
      }

      // gender: if provided on update, must be present and valid
      if (data?.gender !== undefined) {
        if (!data.gender) fieldErrors.gender = 'Gênero é obrigatório';
        else if (!['MALE','FEMALE','OTHER'].includes(String(data.gender).toUpperCase())) fieldErrors.gender = 'Gênero inválido';
      }

      if (Object.keys(fieldErrors).length > 0) return reply.code(400).send({ error: 'Validation failed', fields: fieldErrors });

      const updateData: any = { ...data };

      if (data.birthDate !== undefined) {
        if (data.birthDate) {
          const birthDate = new Date(data.birthDate);
          if (Number.isNaN(birthDate.getTime())) {
            return reply.code(400).send({ error: 'Invalid birthDate' });
          }
          updateData.birthDate = birthDate;
        } else {
          delete updateData.birthDate;
        }
      }

      if (data.healthInsuranceExpiry !== undefined) {
        if (data.healthInsuranceExpiry) {
          const healthInsuranceExpiry = new Date(data.healthInsuranceExpiry);
          if (Number.isNaN(healthInsuranceExpiry.getTime())) {
            return reply.code(400).send({ error: 'Invalid healthInsuranceExpiry' });
          }
          updateData.healthInsuranceExpiry = healthInsuranceExpiry;
        } else {
          updateData.healthInsuranceExpiry = null;
        }
      }

      const patient = await prisma.patient.update({
        where: { id },
        data: updateData,
      });

      return patient;
    } catch (error: any) {
      if (error.code === 'P2002') {
        const field = error.meta?.target?.[0];
        return reply.code(400).send({ error: 'Validation failed', fields: { [field]: `${field} já existe` } });
      }
      return reply.code(400).send({ error: 'Failed to update patient', details: error.message });
    }
  });

  // Delete patient
  app.delete('/:id', {
    schema: {
      summary: 'Delete a patient',
      tags: ['Patients'],
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
        400: {
          type: 'object',
          properties: { error: { type: 'string' }, details: { type: 'string' } },
          additionalProperties: true,
        },
        404: {
          type: 'object',
          properties: { error: { type: 'string' } },
          additionalProperties: true,
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const existing = await prisma.patient.findUnique({ where: { id } });

    if (!existing) {
      return reply.code(404).send({ error: 'Patient not found' });
    }

    // Check for appointments and medical records
    const [appointmentsCount, recordsCount] = await Promise.all([
      prisma.appointment.count({ where: { patientId: id } }),
      prisma.medicalRecord.count({ where: { patientId: id } }),
    ]);

    if (appointmentsCount > 0 || recordsCount > 0) {
      return reply.code(400).send({
        error: 'Cannot delete patient',
        details: `This patient has ${appointmentsCount} appointment(s) and ${recordsCount} medical record(s). Deactivate the patient instead.`,
      });
    }

    await prisma.patient.delete({ where: { id } });

    return { message: 'Patient deleted successfully' };
  });

  // Get patient history (appointments + medical records)
  app.get('/:id/history', {
    schema: {
      summary: 'Get patient medical history',
      tags: ['Patients'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            patient: { $ref: 'Patient#' },
            medicalRecords: {
              type: 'array',
              items: { $ref: 'MedicalRecord#' },
            },
          },
        },
        404: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const patient = await prisma.patient.findUnique({ where: { id } });

    if (!patient) {
      return reply.code(404).send({ error: 'Patient not found' });
    }

    const medicalRecords = await prisma.medicalRecord.findMany({
      where: { patientId: id },
      include: {
        doctor: {
          select: {
            id: true,
            name: true,
            specialty: true,
            crm: true,
            crmState: true,
          },
        },
      },
      orderBy: { recordDate: 'desc' },
    });

    return { patient, medicalRecords };
  });

  // Get patient statistics
  app.get('/stats/overview', {
    schema: {
      summary: 'Get patient statistics overview',
      tags: ['Patients'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            totalPatients: { type: 'number' },
            activePatients: { type: 'number' },
            withHealthInsurance: { type: 'number' },
            withoutHealthInsurance: { type: 'number' },
            byGender: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  gender: { type: 'string' },
                  count: { type: 'number' },
                },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const [
      totalPatients,
      activePatients,
      withHealthInsurance,
      genderStats,
    ] = await Promise.all([
      prisma.patient.count(),
      prisma.patient.count({ where: { isActive: true } }),
      prisma.patient.count({ where: { hasHealthInsurance: true } }),
      prisma.patient.groupBy({
        by: ['gender'],
        _count: { gender: true },
      }),
    ]);

    const byGender = genderStats.map((g: { gender: string; _count: { gender: number } }) => ({
      gender: g.gender,
      count: g._count.gender,
    }));

    return {
      totalPatients,
      activePatients,
      withHealthInsurance,
      withoutHealthInsurance: totalPatients - withHealthInsurance,
      byGender,
    };
  });
}
