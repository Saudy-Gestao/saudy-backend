import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';
import { isValidCpf, normalizeCpf } from '../../../lib/cpf';
import { isValidEmail, normalizeEmail } from '../../../lib/email';

const getUniqueConstraintField = (target: unknown): string | null => {
  if (Array.isArray(target)) {
    const first = target.find((item) => typeof item === 'string' && item.trim().length > 0);
    return typeof first === 'string' ? first : null;
  }

  if (typeof target === 'string' && target.trim().length > 0) {
    const normalized = target.trim();
    if (normalized.includes('cpf')) return 'cpf';
    if (normalized.includes('email')) return 'email';
    if (normalized.includes('guardianCpf')) return 'guardianCpf';
    return normalized;
  }

  return null;
};

const getUniqueConstraintMessage = (field: string) => {
  const messages: Record<string, string> = {
    cpf: 'Já existe um paciente com este CPF nesta empresa',
    email: 'Já existe um paciente com este e-mail',
    guardianCpf: 'Já existe um paciente com este CPF do responsável',
    registro: 'Já existe um registro com estes dados',
  };

  return messages[field] || `Já existe um registro com o campo ${field}`;
};

export default async function patientRoutes(app: FastifyInstance) {
  const getLoggedContext = async (request: any) => {
    const userId = (request.user as any)?.id;
    if (!userId) return null;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });
    const branchId = user?.sector?.branch?.id || null;
    const companyId = user?.sector?.branch?.companyId || null;
    return branchId && companyId ? { branchId, companyId } : null;
  };

  // Auth hook for all routes in this plugin
  app.addHook('onRequest', async (request, reply) => {
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
        403: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const ctx = await getLoggedContext(request);
    if (!ctx) return reply.code(403).send({ error: 'User not associated with a branch' });

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

    const where: any = { companyId: ctx.companyId };

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
        403: { type: 'object' },
        404: {
          type: 'object',
          properties: { error: { type: 'string' } },
          additionalProperties: true,
        },
      },
    },
  }, async (request, reply) => {
    const ctx = await getLoggedContext(request);
    if (!ctx) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as { id: string };

    const patient = await prisma.patient.findFirst({
      where: { id, companyId: ctx.companyId },
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
        403: { type: 'object' },
        400: { type: 'object' },
        404: {
          type: 'object',
          properties: { error: { type: 'string' } },
          additionalProperties: true,
        },
      },
    },
  }, async (request, reply) => {
    const ctx = await getLoggedContext(request);
    if (!ctx) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { cpf } = request.params as { cpf: string };
    const normalizedCpf = normalizeCpf(cpf);

    if (!isValidCpf(normalizedCpf)) {
      return reply.code(400).send({ error: 'Invalid CPF' });
    }

    const patient = await prisma.patient.findFirst({
      where: { cpf: normalizedCpf, companyId: ctx.companyId },
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
      response: {
        201: { $ref: 'Patient#' },
        400: { type: 'object', additionalProperties: true },
        403: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const ctx = await getLoggedContext(request);
    if (!ctx) return reply.code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;

    if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
      request.log.warn({ body: data }, 'Empty or missing request body for patient create');
      return reply.code(400).send({ error: 'Bad Request', details: 'Request body is empty or could not be parsed as JSON. Ensure Content-Type: application/json and valid JSON body.' });
    }

    const fieldErrors: Record<string,string> = {};
    if (!data?.name || String(data.name).trim() === '') fieldErrors.name = 'Nome é obrigatório';
    const normalizedCpf = normalizeCpf(data?.cpf);
    const normalizedEmail = normalizeEmail(data?.email);
    if (!isValidCpf(normalizedCpf)) fieldErrors.cpf = 'CPF inválido';
    if (!data?.birthDate || isNaN(Date.parse(String(data.birthDate)))) fieldErrors.birthDate = 'Data de nascimento inválida';
    else if (new Date(String(data.birthDate)) > new Date()) fieldErrors.birthDate = 'Data de nascimento inválida';
    if (data?.gender !== undefined && data?.gender !== null && String(data.gender).trim() !== '') {
      if (!['MALE','FEMALE','OTHER'].includes(String(data.gender).toUpperCase())) fieldErrors.gender = 'Gênero inválido';
    }
    if (data?.email !== undefined && normalizedEmail && !isValidEmail(normalizedEmail)) fieldErrors.email = 'Email inválido';
    if (data?.hasHealthInsurance && !data?.healthInsuranceName) fieldErrors.healthInsuranceName = 'Nome do convênio é obrigatório';

    if (!data?.cellphone) fieldErrors.cellphone = 'Celular é obrigatório';
    else if (!/^\d{10,11}$/.test(String(data.cellphone))) fieldErrors.cellphone = 'Celular inválido';

    const normalizedGuardianCpf = normalizeCpf(data?.guardianCpf);
    if (data?.guardianCpf !== undefined && data?.guardianCpf !== null && String(data.guardianCpf).trim() !== '') {
      if (!isValidCpf(normalizedGuardianCpf)) fieldErrors.guardianCpf = 'CPF do responsável inválido';
    }

    if (Object.keys(fieldErrors).length > 0) {
      return reply.code(400).send({ error: 'Validation failed', fields: fieldErrors });
    }

    try {
      const patient = await prisma.patient.create({
        data: {
          ...data,
          gender: data?.gender !== undefined && data?.gender !== null && String(data.gender).trim() !== ''
            ? String(data.gender).toUpperCase()
            : null,
          cpf: normalizedCpf,
          email: normalizedEmail || null,
          guardianCpf: normalizedGuardianCpf || null,
          branchId: ctx.branchId,
          companyId: ctx.companyId,
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
        const field = getUniqueConstraintField(error.meta?.target) || 'registro';
        return reply.code(400).send({
          error: 'Validation failed',
          message: getUniqueConstraintMessage(field),
          fields: { [field]: getUniqueConstraintMessage(field) },
        });
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
        403: { type: 'object' },
        404: {
          type: 'object',
          properties: { error: { type: 'string' } },
          additionalProperties: true,
        },
      },
    },
  }, async (request, reply) => {
    const ctx = await getLoggedContext(request);
    if (!ctx) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as { id: string };
    const data = request.body as any;

    const existing = await prisma.patient.findFirst({ where: { id, companyId: ctx.companyId } });

    if (!existing) {
      return reply.code(404).send({ error: 'Patient not found' });
    }

    try {
      const fieldErrors: Record<string,string> = {};
      const normalizedEmail = normalizeEmail(data?.email);
      if (data?.email !== undefined && normalizedEmail && !isValidEmail(normalizedEmail)) fieldErrors.email = 'Email inválido';
      const normalizedCpf = normalizeCpf(data?.cpf);
      if (data?.cpf !== undefined && String(data.cpf).trim() !== '' && !isValidCpf(normalizedCpf)) fieldErrors.cpf = 'CPF inválido';
      const normalizedGuardianCpf = normalizeCpf(data?.guardianCpf);
      if (data?.guardianCpf !== undefined && String(data.guardianCpf).trim() !== '' && !isValidCpf(normalizedGuardianCpf)) {
        fieldErrors.guardianCpf = 'CPF do responsável inválido';
      }
      if (data?.birthDate !== undefined && data.birthDate && (isNaN(Date.parse(String(data.birthDate))) || new Date(String(data.birthDate)) > new Date())) fieldErrors.birthDate = 'Data de nascimento inválida';
      if (data?.hasHealthInsurance && data.hasHealthInsurance && !data?.healthInsuranceName) fieldErrors.healthInsuranceName = 'Nome do convênio é obrigatório';

      if (data?.cellphone !== undefined) {
        if (!data.cellphone) fieldErrors.cellphone = 'Celular é obrigatório';
        else if (!/^\d{10,11}$/.test(String(data.cellphone))) fieldErrors.cellphone = 'Celular inválido';
      }

      if (data?.gender !== undefined) {
        if (data.gender !== null && String(data.gender).trim() !== '' && !['MALE','FEMALE','OTHER'].includes(String(data.gender).toUpperCase())) {
          fieldErrors.gender = 'Gênero inválido';
        }
      }

      if (Object.keys(fieldErrors).length > 0) return reply.code(400).send({ error: 'Validation failed', fields: fieldErrors });

      const updateData: any = { ...data };
      if (data?.gender !== undefined) updateData.gender = data.gender !== null && String(data.gender).trim() !== ''
        ? String(data.gender).toUpperCase()
        : null;
      if (data?.cpf !== undefined) updateData.cpf = normalizedCpf || null;
      if (data?.email !== undefined) updateData.email = normalizedEmail || null;
      if (data?.guardianCpf !== undefined) updateData.guardianCpf = normalizedGuardianCpf || null;

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

      // Never allow overriding companyId or branchId via update payload
      delete updateData.companyId;
      delete updateData.branchId;

      const patient = await prisma.patient.update({
        where: { id },
        data: updateData,
      });

      return patient;
    } catch (error: any) {
      if (error.code === 'P2002') {
        const field = getUniqueConstraintField(error.meta?.target) || 'registro';
        return reply.code(400).send({
          error: 'Validation failed',
          message: getUniqueConstraintMessage(field),
          fields: { [field]: getUniqueConstraintMessage(field) },
        });
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
        403: { type: 'object' },
        404: {
          type: 'object',
          properties: { error: { type: 'string' } },
          additionalProperties: true,
        },
      },
    },
  }, async (request, reply) => {
    const ctx = await getLoggedContext(request);
    if (!ctx) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as { id: string };

    const existing = await prisma.patient.findFirst({ where: { id, companyId: ctx.companyId } });

    if (!existing) {
      return reply.code(404).send({ error: 'Patient not found' });
    }

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
        403: { type: 'object' },
        404: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const ctx = await getLoggedContext(request);
    if (!ctx) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as { id: string };

    const patient = await prisma.patient.findFirst({ where: { id, companyId: ctx.companyId } });

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
        403: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const ctx = await getLoggedContext(request);
    if (!ctx) return reply.code(403).send({ error: 'User not associated with a branch' });

    const [
      totalPatients,
      activePatients,
      withHealthInsurance,
      genderStats,
    ] = await Promise.all([
      prisma.patient.count({ where: { companyId: ctx.companyId } }),
      prisma.patient.count({ where: { companyId: ctx.companyId, isActive: true } }),
      prisma.patient.count({ where: { companyId: ctx.companyId, hasHealthInsurance: true } }),
      prisma.patient.groupBy({
        where: { companyId: ctx.companyId },
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
