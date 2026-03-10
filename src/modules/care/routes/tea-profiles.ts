import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

function normalizeCpf(value?: string): string {
  return String(value || '').replace(/\D/g, '');
}

function toGender(value?: string): 'MALE' | 'FEMALE' | 'OTHER' | undefined {
  if (!value) return undefined;
  const normalized = String(value).toUpperCase();
  if (normalized === 'MASCULINO' || normalized === 'M') return 'MALE';
  if (normalized === 'FEMININO' || normalized === 'F') return 'FEMALE';
  if (normalized === 'MALE' || normalized === 'FEMALE' || normalized === 'OTHER') return normalized;
  return undefined;
}

function normalizePreferredShift(value?: string): string | undefined {
  if (!value) return undefined;
  const tokens = String(value)
    .split(',')
    .map((token) => String(token)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .trim())
    .filter((token) => token === 'MANHA' || token === 'TARDE' || token === 'NOITE');

  if (!tokens.length) return undefined;

  const unique = Array.from(new Set(tokens));
  const shiftOrder: Array<'MANHA' | 'TARDE' | 'NOITE'> = ['MANHA', 'TARDE', 'NOITE'];
  const ordered = shiftOrder.filter((shift) => unique.includes(shift));
  return ordered.join(',');
}

const OPEN_PRE_RESERVATION_STATUSES = [
  'PENDING_SCHEDULING',
  'PROPOSED',
  'RESERVED',
  'PENDING_AUTHORIZATION',
  'AUTHORIZED',
] as const;

function resolveActorFromRequest(request: any): string {
  const user = request?.user as any;
  return String(user?.name || user?.email || user?.id || 'SYSTEM');
}

function normalizeWeekdays(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((day) => typeof day === 'string' && day.trim() !== '')
    .map((day) => String(day).trim().toUpperCase())
    .sort();
}

function buildTherapySignature(therapy: any): string {
  return [
    String(therapy?.procedureId || '').trim(),
    String(therapy?.therapyType || '').trim().toLowerCase(),
    String(therapy?.professionalDoctorId || '').trim(),
    String(therapy?.preferredShift || '').trim(),
    String(Number.isFinite(therapy?.weeklyFrequency) ? Number(therapy.weeklyFrequency) : 1),
    normalizeWeekdays(therapy?.preferredWeekdays).join(','),
  ].join('|');
}

function formatDateToIso(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function resolveDoctorNameById(doctorId?: string, branchId?: string): Promise<string | null> {
  if (!doctorId) return null;
  const doctor = await prisma.doctor.findFirst({
    where: { id: String(doctorId), ...(branchId ? { branchId } : {}) },
    select: { name: true },
  });
  return doctor?.name ? String(doctor.name) : null;
}

async function resolveProcedureNameById(procedureId?: string, branchId?: string): Promise<string | null> {
  if (!procedureId) return null;
  const procedure = await prisma.procedure.findFirst({
    where: { id: String(procedureId), ...(branchId ? { branchId } : {}) },
    select: { name: true },
  });
  return procedure?.name ? String(procedure.name) : null;
}

export default async function teaProfilesRoutes(app: FastifyInstance) {
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
      return (reply as any).code(403).send({ error: 'User not associated with a branch' });
    }

    (request as any).branchId = branchId;
  });

  app.get('/', {
    schema: {
      summary: 'List TEA profiles',
      tags: ['TeaProfiles'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request) => {
    const branchId = (request as any).branchId as string;
    const { search, limit = 50, offset = 0 } = request.query as any;

    const where: any = { isActive: true, patient: { branchId } };
    if (search) {
      where.patient = {
        branchId,
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { cpf: { contains: search, mode: 'insensitive' } },
        ],
      };
    }

    const [items, total] = await Promise.all([
      prisma.teaProfile.findMany({
        where,
        include: {
          patient: {
            select: {
              id: true,
              name: true,
              cpf: true,
              birthDate: true,
              gender: true,
              cellphone: true,
              email: true,
              healthInsuranceName: true,
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.teaProfile.count({ where }),
    ]);

    return { items, total };
  });

  app.get('/:id', {
    schema: {
      summary: 'Get TEA profile by id',
      tags: ['TeaProfiles'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  }, async (request, reply) => {
    const branchId = (request as any).branchId as string;
    const { id } = request.params as { id: string };
    const item = await prisma.teaProfile.findFirst({
      where: { id, patient: { branchId } },
      include: {
        patient: {
          select: {
            id: true,
            name: true,
            cpf: true,
            birthDate: true,
            gender: true,
            cellphone: true,
            email: true,
            healthInsuranceName: true,
          },
        },
      },
    });

    if (!item) return reply.code(404).send({ error: 'TEA profile not found' });
    return item;
  });

  app.post('/upsert', {
    schema: {
      summary: 'Create/update TEA profile linked to base Patient',
      tags: ['TeaProfiles'],
      body: {
        type: 'object',
        properties: {
          patientId: { type: 'string' },
          patient: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              cpf: { type: 'string' },
              birthDate: { type: 'string' },
              gender: { type: 'string' },
              cellphone: { type: 'string' },
              email: { type: 'string' },
              phone: { type: 'string' },
              healthInsuranceName: { type: 'string' },
              healthInsuranceNumber: { type: 'string' },
              observations: { type: 'string' },
            },
          },
          tea: {
            type: 'object',
            properties: {
              supportLevel: { type: 'string' },
              communicationProfile: { type: 'string' },
              sensoryProfile: { type: 'string' },
              behaviorNotes: { type: 'string' },
              comorbidities: {
                type: 'array',
                items: { type: 'string' },
              },
              therapeuticGoals: { type: 'string' },
              familyGuidance: { type: 'string' },
              schoolNotes: { type: 'string' },
              isActive: { type: 'boolean' },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = (request as any).branchId as string;
    const body = request.body as any;
    const patientPayload = body?.patient || {};
    const teaPayload = body?.tea || {};

    let patient: any = null;

    if (body?.patientId) {
      patient = await prisma.patient.findFirst({ where: { id: String(body.patientId), branchId } });
      if (!patient) return reply.code(404).send({ error: 'Patient not found for provided patientId' });
    }

    if (!patient) {
      const cpf = normalizeCpf(patientPayload?.cpf);
      if (cpf) {
        patient = await prisma.patient.findFirst({ where: { cpf, branchId } });
      }
    }

    if (!patient) {
      const cpf = normalizeCpf(patientPayload?.cpf);
      const gender = toGender(patientPayload?.gender);

      const fieldErrors: Record<string, string> = {};
      if (!patientPayload?.name) fieldErrors.name = 'Nome é obrigatório para criar paciente base';
      if (!cpf || cpf.length !== 11) fieldErrors.cpf = 'CPF deve conter 11 dígitos';
      if (!patientPayload?.birthDate || Number.isNaN(new Date(patientPayload.birthDate).getTime())) fieldErrors.birthDate = 'Data de nascimento válida é obrigatória';
      if (!gender) fieldErrors.gender = 'Gênero é obrigatório (MALE/FEMALE/OTHER)';
      if (!patientPayload?.cellphone) fieldErrors.cellphone = 'Celular é obrigatório';

      if (Object.keys(fieldErrors).length > 0) {
        return reply.code(400).send({ error: 'Validation failed', fields: fieldErrors });
      }

      patient = await prisma.patient.create({
        data: {
          branchId,
          name: String(patientPayload.name),
          cpf,
          birthDate: new Date(patientPayload.birthDate),
          gender,
          cellphone: String(patientPayload.cellphone),
          email: patientPayload.email || null,
          phone: patientPayload.phone || null,
          healthInsuranceName: patientPayload.healthInsuranceName || null,
          healthInsuranceNumber: patientPayload.healthInsuranceNumber || null,
          hasHealthInsurance: Boolean(patientPayload.healthInsuranceName),
          observations: patientPayload.observations || null,
        },
      });
    } else {
      const updateData: any = {};
      if (patientPayload?.name) updateData.name = String(patientPayload.name);
      if (patientPayload?.birthDate && !Number.isNaN(new Date(patientPayload.birthDate).getTime())) updateData.birthDate = new Date(patientPayload.birthDate);
      if (patientPayload?.gender && toGender(patientPayload.gender)) updateData.gender = toGender(patientPayload.gender);
      if (patientPayload?.cellphone) updateData.cellphone = String(patientPayload.cellphone);
      if (patientPayload?.email !== undefined) updateData.email = patientPayload.email || null;
      if (patientPayload?.phone !== undefined) updateData.phone = patientPayload.phone || null;
      if (patientPayload?.healthInsuranceName !== undefined) {
        updateData.healthInsuranceName = patientPayload.healthInsuranceName || null;
        updateData.hasHealthInsurance = Boolean(patientPayload.healthInsuranceName);
      }
      if (patientPayload?.healthInsuranceNumber !== undefined) updateData.healthInsuranceNumber = patientPayload.healthInsuranceNumber || null;
      if (patientPayload?.observations !== undefined) updateData.observations = patientPayload.observations || null;

      if (Object.keys(updateData).length > 0) {
        patient = await prisma.patient.update({
          where: { id: patient.id },
          data: updateData,
        });
      }
    }

    const teaProfile = await prisma.teaProfile.upsert({
      where: { patientId: patient.id },
      update: {
        supportLevel: teaPayload.supportLevel ?? undefined,
        communicationProfile: teaPayload.communicationProfile ?? undefined,
        sensoryProfile: teaPayload.sensoryProfile ?? undefined,
        behaviorNotes: teaPayload.behaviorNotes ?? undefined,
        comorbidities: Array.isArray(teaPayload.comorbidities) ? teaPayload.comorbidities : undefined,
        therapeuticGoals: teaPayload.therapeuticGoals ?? undefined,
        familyGuidance: teaPayload.familyGuidance ?? undefined,
        schoolNotes: teaPayload.schoolNotes ?? undefined,
        isActive: teaPayload.isActive ?? undefined,
      },
      create: {
        patientId: patient.id,
        supportLevel: teaPayload.supportLevel || null,
        communicationProfile: teaPayload.communicationProfile || null,
        sensoryProfile: teaPayload.sensoryProfile || null,
        behaviorNotes: teaPayload.behaviorNotes || null,
        comorbidities: Array.isArray(teaPayload.comorbidities) ? teaPayload.comorbidities : [],
        therapeuticGoals: teaPayload.therapeuticGoals || null,
        familyGuidance: teaPayload.familyGuidance || null,
        schoolNotes: teaPayload.schoolNotes || null,
        isActive: teaPayload.isActive ?? true,
      },
      include: {
        patient: {
          select: {
            id: true,
            name: true,
            cpf: true,
            birthDate: true,
            gender: true,
            cellphone: true,
            email: true,
            healthInsuranceName: true,
          },
        },
      },
    });

    return reply.code(201).send(teaProfile);
  });

  app.get('/:teaProfileId/plans', {
    schema: {
      summary: 'List therapeutic plans by TEA profile',
      tags: ['TeaProfiles'],
      params: {
        type: 'object',
        properties: { teaProfileId: { type: 'string' } },
        required: ['teaProfileId'],
      },
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = (request as any).branchId as string;
    const { teaProfileId } = request.params as { teaProfileId: string };
    const { search, isActive } = request.query as { search?: string; isActive?: boolean };

    const teaProfile = await prisma.teaProfile.findFirst({ where: { id: teaProfileId, patient: { branchId } } });
    if (!teaProfile) return reply.code(404).send({ error: 'TEA profile not found' });

    const where: any = { teaProfileId };
    if (isActive !== undefined) where.isActive = isActive;
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { objective: { contains: search, mode: 'insensitive' } },
        { responsibleProfessional: { contains: search, mode: 'insensitive' } },
      ];
    }

    const items = await prisma.teaTherapeuticPlan.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    return { items, total: items.length };
  });

  app.post('/:teaProfileId/plans', {
    schema: {
      summary: 'Create therapeutic plan for TEA profile',
      tags: ['TeaProfiles'],
      params: {
        type: 'object',
        properties: { teaProfileId: { type: 'string' } },
        required: ['teaProfileId'],
      },
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string' },
          objective: { type: 'string' },
          priority: { type: 'string' },
          status: { type: 'string' },
          responsibleDoctorId: { type: 'string' },
          responsibleProfessional: { type: 'string' },
          targetDate: { type: 'string' },
          notes: { type: 'string' },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = (request as any).branchId as string;
    const { teaProfileId } = request.params as { teaProfileId: string };
    const data = request.body as any;

    const teaProfile = await prisma.teaProfile.findFirst({ where: { id: teaProfileId, patient: { branchId } } });
    if (!teaProfile) return reply.code(404).send({ error: 'TEA profile not found' });

    if (!data?.title || String(data.title).trim() === '') {
      return reply.code(400).send({ error: 'Validation failed', fields: { title: 'Título é obrigatório' } });
    }

    const responsibleDoctorId = data.responsibleDoctorId ? String(data.responsibleDoctorId) : null;
    const resolvedResponsibleProfessional = responsibleDoctorId
      ? await resolveDoctorNameById(responsibleDoctorId, branchId)
      : null;

    if (responsibleDoctorId && !resolvedResponsibleProfessional) {
      return reply.code(400).send({ error: 'Validation failed', fields: { responsibleDoctorId: 'Médico responsável inválido' } });
    }

    const plan = await prisma.teaTherapeuticPlan.create({
      data: {
        teaProfileId,
        title: String(data.title).trim(),
        objective: data.objective || null,
        priority: data.priority || 'Média',
        status: data.status || 'Ativo',
        responsibleDoctorId,
        responsibleProfessional: resolvedResponsibleProfessional || data.responsibleProfessional || null,
        targetDate: data.targetDate ? new Date(data.targetDate) : null,
        notes: data.notes || null,
        isActive: data.isActive ?? true,
      },
    });

    return reply.code(201).send(plan);
  });

  app.put('/plans/:planId', {
    schema: {
      summary: 'Update therapeutic plan',
      tags: ['TeaProfiles'],
      params: {
        type: 'object',
        properties: { planId: { type: 'string' } },
        required: ['planId'],
      },
      body: { type: 'object' },
    },
  }, async (request, reply) => {
    const branchId = (request as any).branchId as string;
    const { planId } = request.params as { planId: string };
    const data = request.body as any;

    const existing = await prisma.teaTherapeuticPlan.findFirst({
      where: { id: planId, teaProfile: { patient: { branchId } } },
    });
    if (!existing) return reply.code(404).send({ error: 'Therapeutic plan not found' });

    const updateData: any = { ...data };
    if (data?.targetDate !== undefined) {
      updateData.targetDate = data.targetDate ? new Date(data.targetDate) : null;
    }

    if (data?.responsibleDoctorId !== undefined) {
      const responsibleDoctorId = data.responsibleDoctorId ? String(data.responsibleDoctorId) : null;
      if (responsibleDoctorId) {
        const resolvedResponsibleProfessional = await resolveDoctorNameById(responsibleDoctorId, branchId);
        if (!resolvedResponsibleProfessional) {
          return reply.code(400).send({ error: 'Validation failed', fields: { responsibleDoctorId: 'Médico responsável inválido' } });
        }
        updateData.responsibleDoctorId = responsibleDoctorId;
        updateData.responsibleProfessional = resolvedResponsibleProfessional;
      } else {
        updateData.responsibleDoctorId = null;
        updateData.responsibleProfessional = null;
      }
    }

    const item = await prisma.teaTherapeuticPlan.update({
      where: { id: planId },
      data: updateData,
    });

    return item;
  });

  app.delete('/plans/:planId', {
    schema: {
      summary: 'Deactivate therapeutic plan',
      tags: ['TeaProfiles'],
      params: {
        type: 'object',
        properties: { planId: { type: 'string' } },
        required: ['planId'],
      },
    },
  }, async (request, reply) => {
    const branchId = (request as any).branchId as string;
    const { planId } = request.params as { planId: string };

    const existing = await prisma.teaTherapeuticPlan.findFirst({ where: { id: planId, teaProfile: { patient: { branchId } } } });
    if (!existing) return reply.code(404).send({ error: 'Therapeutic plan not found' });

    await prisma.teaTherapeuticPlan.update({
      where: { id: planId },
      data: { isActive: false, status: 'Inativo' },
    });

    return { message: 'Therapeutic plan deactivated' };
  });

  app.get('/:teaProfileId/evolutions', {
    schema: {
      summary: 'List evolution records by TEA profile',
      tags: ['TeaProfiles'],
      params: {
        type: 'object',
        properties: { teaProfileId: { type: 'string' } },
        required: ['teaProfileId'],
      },
    },
  }, async (request, reply) => {
    const branchId = (request as any).branchId as string;
    const { teaProfileId } = request.params as { teaProfileId: string };

    const teaProfile = await prisma.teaProfile.findFirst({ where: { id: teaProfileId, patient: { branchId } } });
    if (!teaProfile) return reply.code(404).send({ error: 'TEA profile not found' });

    const items = await prisma.teaEvolution.findMany({
      where: { teaProfileId },
      include: {
        therapeuticPlan: {
          select: { id: true, title: true },
        },
      },
      orderBy: { sessionDate: 'desc' },
    });

    return { items, total: items.length };
  });

  app.post('/:teaProfileId/evolutions', {
    schema: {
      summary: 'Create evolution record',
      tags: ['TeaProfiles'],
      params: {
        type: 'object',
        properties: { teaProfileId: { type: 'string' } },
        required: ['teaProfileId'],
      },
      body: {
        type: 'object',
        properties: {
          therapeuticPlanId: { type: 'string' },
          sessionDate: { type: 'string' },
          professionalDoctorId: { type: 'string' },
          professional: { type: 'string' },
          interventionSummary: { type: 'string' },
          patientResponse: { type: 'string' },
          progressScore: { type: 'number' },
          notes: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = (request as any).branchId as string;
    const { teaProfileId } = request.params as { teaProfileId: string };
    const data = request.body as any;
    const actor = resolveActorFromRequest(request);

    const teaProfile = await prisma.teaProfile.findFirst({ where: { id: teaProfileId, patient: { branchId } } });
    if (!teaProfile) return reply.code(404).send({ error: 'TEA profile not found' });

    if (data?.therapeuticPlanId) {
      const plan = await prisma.teaTherapeuticPlan.findFirst({
        where: { id: String(data.therapeuticPlanId), teaProfileId },
      });
      if (!plan) return reply.code(400).send({ error: 'Therapeutic plan does not belong to this TEA profile' });
    }

    const professionalDoctorId = data.professionalDoctorId ? String(data.professionalDoctorId) : null;
    const resolvedProfessionalName = professionalDoctorId
      ? await resolveDoctorNameById(professionalDoctorId, branchId)
      : null;
    if (professionalDoctorId && !resolvedProfessionalName) {
      return reply.code(400).send({ error: 'Validation failed', fields: { professionalDoctorId: 'Médico inválido' } });
    }

    const item = await prisma.teaEvolution.create({
      data: {
        teaProfileId,
        therapeuticPlanId: data.therapeuticPlanId || null,
        sessionDate: data.sessionDate ? new Date(data.sessionDate) : new Date(),
        professionalDoctorId,
        professional: resolvedProfessionalName || data.professional || null,
        interventionSummary: data.interventionSummary || null,
        patientResponse: data.patientResponse || null,
        progressScore: Number.isFinite(data.progressScore) ? Number(data.progressScore) : null,
        notes: data.notes || null,
      },
      include: {
        therapeuticPlan: {
          select: { id: true, title: true },
        },
      },
    });

    return reply.code(201).send(item);
  });

  app.get('/:teaProfileId/reports', {
    schema: {
      summary: 'Get TEA consolidated report by profile',
      tags: ['TeaProfiles'],
      params: {
        type: 'object',
        properties: { teaProfileId: { type: 'string' } },
        required: ['teaProfileId'],
      },
      querystring: {
        type: 'object',
        properties: {
          startDate: { type: 'string' },
          endDate: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = (request as any).branchId as string;
    const { teaProfileId } = request.params as { teaProfileId: string };
    const { startDate, endDate } = request.query as { startDate?: string; endDate?: string };

    const teaProfile = await prisma.teaProfile.findFirst({
      where: { id: teaProfileId, patient: { branchId } },
      include: {
        patient: {
          select: {
            id: true,
            name: true,
            cpf: true,
            birthDate: true,
          },
        },
      },
    });
    if (!teaProfile) return reply.code(404).send({ error: 'TEA profile not found' });

    const parsedStartDate = startDate ? new Date(startDate) : null;
    const parsedEndDate = endDate ? new Date(endDate) : null;
    const hasInvalidStartDate = parsedStartDate && Number.isNaN(parsedStartDate.getTime());
    const hasInvalidEndDate = parsedEndDate && Number.isNaN(parsedEndDate.getTime());
    if (hasInvalidStartDate || hasInvalidEndDate) {
      return reply.code(400).send({ error: 'Invalid date range. Use YYYY-MM-DD format.' });
    }

    const evolutionDateFilter: any = {};
    if (parsedStartDate) evolutionDateFilter.gte = parsedStartDate;
    if (parsedEndDate) {
      const inclusiveEndDate = new Date(parsedEndDate);
      inclusiveEndDate.setHours(23, 59, 59, 999);
      evolutionDateFilter.lte = inclusiveEndDate;
    }

    const evolutionWhere: any = { teaProfileId };
    if (Object.keys(evolutionDateFilter).length > 0) {
      evolutionWhere.sessionDate = evolutionDateFilter;
    }

    const [
      plansTotal,
      plansActive,
      evolutionsTotal,
      evolutionsWithScore,
      evolutionAverage,
      latestEvolution,
      pit,
    ] = await Promise.all([
      prisma.teaTherapeuticPlan.count({ where: { teaProfileId } }),
      prisma.teaTherapeuticPlan.count({ where: { teaProfileId, isActive: true } }),
      prisma.teaEvolution.count({ where: evolutionWhere }),
      prisma.teaEvolution.count({ where: { ...evolutionWhere, progressScore: { not: null } } }),
      prisma.teaEvolution.aggregate({
        where: { ...evolutionWhere, progressScore: { not: null } },
        _avg: { progressScore: true },
      }),
      prisma.teaEvolution.findFirst({
        where: evolutionWhere,
        include: {
          therapeuticPlan: {
            select: { id: true, title: true },
          },
        },
        orderBy: { sessionDate: 'desc' },
      }),
      prisma.teaPit.findFirst({
        where: { teaProfileId },
        include: {
          therapies: {
            where: { isActive: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      }),
    ]);

    return {
      patient: teaProfile.patient,
      filters: {
        startDate: parsedStartDate ? parsedStartDate.toISOString() : null,
        endDate: parsedEndDate ? parsedEndDate.toISOString() : null,
      },
      summary: {
        plansTotal,
        plansActive,
        plansInactive: Math.max(plansTotal - plansActive, 0),
        evolutionsTotal,
        evolutionsWithScore,
        avgProgressScore: evolutionAverage._avg.progressScore,
      },
      latestEvolution,
      pit: pit
        ? {
            id: pit.id,
            title: pit.title,
            status: pit.status,
            startDate: pit.startDate,
            reviewDate: pit.reviewDate,
            therapiesCount: pit.therapies.length,
            therapies: pit.therapies,
          }
        : null,
    };
  });

  app.get('/:teaProfileId/pit', {
    schema: {
      summary: 'Get PIT by TEA profile',
      tags: ['TeaProfiles'],
      params: {
        type: 'object',
        properties: { teaProfileId: { type: 'string' } },
        required: ['teaProfileId'],
      },
    },
  }, async (request, reply) => {
    const branchId = (request as any).branchId as string;
    const { teaProfileId } = request.params as { teaProfileId: string };

    const teaProfile = await prisma.teaProfile.findFirst({ where: { id: teaProfileId, patient: { branchId } } });
    if (!teaProfile) return reply.code(404).send({ error: 'TEA profile not found' });

    const pit = await prisma.teaPit.findFirst({
      where: { teaProfileId },
      include: {
        therapies: {
          where: { isActive: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    return { item: pit || null };
  });

  app.post('/:teaProfileId/pit/upsert', {
    schema: {
      summary: 'Create or update PIT for TEA profile',
      tags: ['TeaProfiles'],
      params: {
        type: 'object',
        properties: { teaProfileId: { type: 'string' } },
        required: ['teaProfileId'],
      },
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string' },
          startDate: { type: 'string' },
          reviewDate: { type: 'string' },
          status: { type: 'string' },
          notes: { type: 'string' },
          removedTherapies: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id'],
              properties: {
                id: { type: 'string' },
                action: {
                  type: 'string',
                  enum: ['KEEP_FUTURE_APPOINTMENTS', 'CANCEL_FUTURE_APPOINTMENTS'],
                },
              },
            },
          },
          therapies: {
            type: 'array',
            items: {
              type: 'object',
              required: ['therapyType'],
              properties: {
                id: { type: 'string' },
                procedureId: { type: 'string' },
                therapyType: { type: 'string' },
                weeklyFrequency: { type: 'number' },
                preferredWeekdays: {
                  type: 'array',
                  items: { type: 'string' },
                },
                preferredShift: { type: 'string' },
                durationMinutes: { type: 'number' },
                professionalDoctorId: { type: 'string' },
                professional: { type: 'string' },
                notes: { type: 'string' },
                isActive: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = (request as any).branchId as string;
    const { teaProfileId } = request.params as { teaProfileId: string };
    const data = request.body as any;
    const actor = resolveActorFromRequest(request);

    const teaProfile = await prisma.teaProfile.findFirst({ where: { id: teaProfileId, patient: { branchId } } });
    if (!teaProfile) return reply.code(404).send({ error: 'TEA profile not found' });

    if (!data?.title || String(data.title).trim() === '') {
      return reply.code(400).send({ error: 'Validation failed', fields: { title: 'Título do PIT é obrigatório' } });
    }

    const therapies = Array.isArray(data?.therapies)
      ? await Promise.all(
        data.therapies
          .filter((t: any) => t?.therapyType || t?.procedureId)
          .map(async (t: any) => {
            const id = t?.id ? String(t.id).trim() : undefined;
            const procedureId = t.procedureId ? String(t.procedureId) : null;
            const professionalDoctorId = t.professionalDoctorId ? String(t.professionalDoctorId) : null;

            const [resolvedProcedureName, resolvedProfessionalName] = await Promise.all([
              procedureId ? resolveProcedureNameById(procedureId, branchId) : Promise.resolve(null),
              professionalDoctorId ? resolveDoctorNameById(professionalDoctorId, branchId) : Promise.resolve(null),
            ]);

            const hasInvalidProcedure = Boolean(procedureId && !resolvedProcedureName);
            const hasInvalidProfessional = Boolean(professionalDoctorId && !resolvedProfessionalName);
            if (hasInvalidProcedure || hasInvalidProfessional) {
              return {
                __invalidProcedure: hasInvalidProcedure,
                __invalidProfessional: hasInvalidProfessional,
              } as any;
            }

            const therapyType = resolvedProcedureName || String(t.therapyType || '').trim();
            if (!therapyType) return null;

            return {
              id,
              procedureId,
              preferredShift: normalizePreferredShift(t.preferredShift) || null,
              therapyType,
              weeklyFrequency: Number.isFinite(t.weeklyFrequency) ? Number(t.weeklyFrequency) : 1,
              preferredWeekdays: Array.isArray(t.preferredWeekdays)
                ? t.preferredWeekdays.filter((day: any) => typeof day === 'string' && day.trim() !== '')
                : [],
              durationMinutes: Number.isFinite(t.durationMinutes) ? Number(t.durationMinutes) : null,
              professionalDoctorId,
              professional: resolvedProfessionalName || t.professional || null,
              notes: t.notes || null,
              isActive: t.isActive ?? true,
            };
          }),
      )
      : [];

    if (Array.isArray(therapies) && therapies.some((t: any) => t === null)) {
      return reply.code(400).send({ error: 'Validation failed', fields: { therapies: 'Terapia inválida' } });
    }

    if (Array.isArray(therapies) && therapies.some((t: any) => t?.__invalidProcedure)) {
      return reply.code(400).send({ error: 'Validation failed', fields: { procedureId: 'Procedimento inválido nas terapias' } });
    }

    if (Array.isArray(therapies) && therapies.some((t: any) => t?.__invalidProfessional)) {
      return reply.code(400).send({ error: 'Validation failed', fields: { professionalDoctorId: 'Médico inválido nas terapias' } });
    }

    const safeTherapies = (therapies || []).filter((item: any) => item && !item.__invalidProcedure && !item.__invalidProfessional);
    const removedTherapyActionById = new Map<string, 'KEEP_FUTURE_APPOINTMENTS' | 'CANCEL_FUTURE_APPOINTMENTS'>();
    if (Array.isArray(data?.removedTherapies)) {
      data.removedTherapies.forEach((item: any) => {
        const id = String(item?.id || '').trim();
        if (!id) return;
        const action = String(item?.action || 'KEEP_FUTURE_APPOINTMENTS').toUpperCase();
        removedTherapyActionById.set(
          id,
          action === 'CANCEL_FUTURE_APPOINTMENTS' ? 'CANCEL_FUTURE_APPOINTMENTS' : 'KEEP_FUTURE_APPOINTMENTS',
        );
      });
    }
    const pitPayload = {
      title: String(data.title).trim(),
      startDate: data.startDate ? new Date(data.startDate) : null,
      reviewDate: data.reviewDate ? new Date(data.reviewDate) : null,
      status: data.status || 'Ativo',
      notes: data.notes || null,
    };

    const existingPit = await prisma.teaPit.findFirst({
        where: { teaProfileId },
      include: {
        therapies: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!existingPit) {
      const createdPit = await prisma.teaPit.create({
        data: {
          teaProfileId,
          ...pitPayload,
          therapies: {
            create: safeTherapies.map((therapy: any) => ({
              procedureId: therapy.procedureId,
              preferredShift: therapy.preferredShift,
              therapyType: therapy.therapyType,
              weeklyFrequency: therapy.weeklyFrequency,
              preferredWeekdays: therapy.preferredWeekdays,
              durationMinutes: therapy.durationMinutes,
              professionalDoctorId: therapy.professionalDoctorId,
              professional: therapy.professional,
              notes: therapy.notes,
              isActive: therapy.isActive ?? true,
            })),
          },
        },
        include: {
          therapies: {
            where: { isActive: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      return reply.code(201).send(createdPit);
    }

    const existingTherapies = Array.isArray(existingPit.therapies) ? existingPit.therapies : [];
    const existingById = new Map(existingTherapies.map((therapy: any) => [String(therapy.id), therapy]));

    const incomingWithId = safeTherapies.filter((therapy: any) => !!therapy?.id);
    const invalidIncomingId = incomingWithId.find((therapy: any) => !existingById.has(String(therapy.id)));
    if (invalidIncomingId) {
      return reply.code(400).send({
        error: 'Validation failed',
        fields: { therapies: 'Uma ou mais terapias referenciadas não pertencem ao PIT atual' },
      });
    }

    const matchedExistingIds = new Set<string>(incomingWithId.map((therapy: any) => String(therapy.id)));
    const availableBySignature = new Map<string, string[]>();

    existingTherapies
      .filter((therapy: any) => Boolean(therapy?.isActive) && !matchedExistingIds.has(String(therapy.id)))
      .forEach((therapy: any) => {
        const signature = buildTherapySignature(therapy);
        const list = availableBySignature.get(signature) || [];
        list.push(String(therapy.id));
        availableBySignature.set(signature, list);
      });

    const therapiesToUpdate: Array<{ id: string; data: any }> = incomingWithId.map((therapy: any) => ({
      id: String(therapy.id),
      data: therapy,
    }));
    const therapiesToCreate: any[] = [];
    const therapiesToDeactivate = new Set<string>();

    safeTherapies
      .filter((therapy: any) => !therapy?.id)
      .forEach((therapy: any) => {
        const signature = buildTherapySignature(therapy);
        const candidateQueue = availableBySignature.get(signature) || [];
        const matchedId = candidateQueue.shift();
        availableBySignature.set(signature, candidateQueue);

        if (matchedId) {
          matchedExistingIds.add(matchedId);
          therapiesToUpdate.push({ id: matchedId, data: therapy });
          return;
        }

        therapiesToCreate.push(therapy);
      });

    therapiesToUpdate.forEach((entry) => {
      if (entry.data?.isActive === false) {
        therapiesToDeactivate.add(entry.id);
      }
    });

    existingTherapies
      .filter((therapy: any) => Boolean(therapy?.isActive) && !matchedExistingIds.has(String(therapy.id)))
      .forEach((therapy: any) => therapiesToDeactivate.add(String(therapy.id)));

    const resultPit = await prisma.$transaction(async (tx: any) => {
      await tx.teaPit.update({
        where: { id: existingPit.id },
        data: pitPayload,
      });

      await Promise.all(
        therapiesToUpdate.map((entry) => tx.teaPitTherapy.update({
          where: { id: entry.id },
          data: {
            procedureId: entry.data.procedureId,
            preferredShift: entry.data.preferredShift,
            therapyType: entry.data.therapyType,
            weeklyFrequency: entry.data.weeklyFrequency,
            preferredWeekdays: entry.data.preferredWeekdays,
            durationMinutes: entry.data.durationMinutes,
            professionalDoctorId: entry.data.professionalDoctorId,
            professional: entry.data.professional,
            notes: entry.data.notes,
            isActive: entry.data.isActive ?? true,
          },
        })),
      );

      await Promise.all(
        therapiesToCreate.map((therapy) => tx.teaPitTherapy.create({
          data: {
            pitId: existingPit.id,
            procedureId: therapy.procedureId,
            preferredShift: therapy.preferredShift,
            therapyType: therapy.therapyType,
            weeklyFrequency: therapy.weeklyFrequency,
            preferredWeekdays: therapy.preferredWeekdays,
            durationMinutes: therapy.durationMinutes,
            professionalDoctorId: therapy.professionalDoctorId,
            professional: therapy.professional,
            notes: therapy.notes,
            isActive: therapy.isActive ?? true,
          },
        })),
      );

      const deactivateIds = Array.from(therapiesToDeactivate).filter(Boolean);
      if (deactivateIds.length > 0) {
        const todayIso = formatDateToIso(new Date());

        await tx.teaPitTherapy.updateMany({
          where: { id: { in: deactivateIds } },
          data: { isActive: false },
        });

        const preReservationsToCancel = await tx.teaPreReservation.findMany({
          where: {
            pitTherapyId: { in: deactivateIds },
            status: { in: [...OPEN_PRE_RESERVATION_STATUSES] as any },
          },
          select: { id: true },
        });

        if (preReservationsToCancel.length > 0) {
          const idsToCancel = preReservationsToCancel.map((item: any) => String(item.id));
          await tx.teaPreReservation.updateMany({
            where: { id: { in: idsToCancel } },
            data: { status: 'CANCELED' },
          });

          await tx.teaPreReservationTimeline.createMany({
            data: idsToCancel.map((preReservationId: string) => ({
              preReservationId,
              eventType: 'PIT_UPDATED_THERAPY_REMOVED',
              eventLabel: 'Pré-reserva cancelada por remoção/inativação de terapia no PIT',
              actor,
              payload: { source: 'pit-upsert-reconciliation' },
            })),
          });
        }

        const therapyIdsToCancelFutureAppointments = deactivateIds.filter(
          (therapyId) => removedTherapyActionById.get(therapyId) === 'CANCEL_FUTURE_APPOINTMENTS',
        );

        for (const therapyId of therapyIdsToCancelFutureAppointments) {
          const convertedFutureReservations = await tx.teaPreReservation.findMany({
            where: {
              pitTherapyId: therapyId,
              status: 'CONVERTED' as any,
              suggestedDate: { gte: new Date(`${todayIso}T00:00:00`) },
            },
            select: {
              id: true,
              patientId: true,
              suggestedDate: true,
              suggestedTime: true,
              professionalName: true,
              procedureName: true,
            },
          });

          for (const reservation of convertedFutureReservations) {
            if (!reservation?.suggestedDate || !reservation?.suggestedTime) continue;
            const appointmentDate = formatDateToIso(new Date(reservation.suggestedDate));

            await tx.appointment.updateMany({
              where: {
                isActive: true,
                patientId: reservation.patientId,
                date: appointmentDate,
                time: reservation.suggestedTime,
                doctorName: reservation.professionalName || undefined,
                specialty: reservation.procedureName || undefined,
                type: 'RETORNO TEA',
                NOT: [
                  { status: 'CANCELED' },
                  { status: 'COMPLETED' },
                ],
              },
              data: {
                status: 'CANCELED',
                isActive: false,
              },
            });
          }
        }
      }

      return tx.teaPit.findUnique({
        where: { id: existingPit.id },
        include: {
          therapies: {
            where: { isActive: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      });
    });

    return reply.code(201).send(resultPit);
  });
}
