import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

const normalizeStatusKey = (value?: string | null) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toUpperCase();

const canonicalClinicalQueueStatus = (value?: string | null) => {
  const key = normalizeStatusKey(value);
  if (!key) return '';
  return key.replace(/\s+/g, '_');
};

const CLINICAL_QUEUE_TRANSITION_RULES: Record<string, string[]> = {
  AGUARDANDO_ATENDIMENTO: ['CHAMADO_PARA_ATENDIMENTO', 'CANCELADO', 'CANCELADA'],
  AGUARDANDO_TRIAGEM: ['EM_TRIAGEM', 'CANCELADO', 'CANCELADA'],
  EM_TRIAGEM: ['AGUARDANDO_EXAME', 'CANCELADO', 'CANCELADA'],
  AGUARDANDO_EXAME: ['CHAMADO_PARA_EXAME', 'CANCELADO', 'CANCELADA'],
  CHAMADO_PARA_EXAME: ['EM_EXAME', 'CANCELADO', 'CANCELADA'],
  EM_EXAME: ['EXAME_CONCLUIDO', 'CANCELADO', 'CANCELADA'],
  EXAME_CONCLUIDO: [],
  CHAMADO_PARA_ATENDIMENTO: ['EM_ATENDIMENTO', 'CANCELADO', 'CANCELADA'],
  EM_ATENDIMENTO: ['ATENDIMENTO_CONCLUIDO', 'CANCELADO', 'CANCELADA'],
  ATENDIMENTO_CONCLUIDO: [],
  CANCELADO: [],
  CANCELADA: [],
};

const canTransitionClinicalQueue = (fromRaw?: string | null, toRaw?: string | null) => {
  const from = canonicalClinicalQueueStatus(fromRaw);
  const to = canonicalClinicalQueueStatus(toRaw);
  if (!to || from === to) return true;
  if (!from) return true;
  const allowed = CLINICAL_QUEUE_TRANSITION_RULES[from];
  if (!Array.isArray(allowed)) return true;
  return allowed.includes(to);
};

const appendQueueStatusAudit = (
  previousTriageNotes: string | null | undefined,
  fromStatus?: string | null,
  toStatus?: string | null,
  userId?: string | null,
) => {
  const from = String(fromStatus || '').trim() || 'SEM_STATUS';
  const to = String(toStatus || '').trim() || 'SEM_STATUS';
  if (from === to) return previousTriageNotes || null;

  const timestamp = new Date().toISOString();
  const actor = userId ? `user:${userId}` : 'user:unknown';
  const line = `[queue-transition] ${timestamp} ${actor} "${from}" -> "${to}"`;
  return [String(previousTriageNotes || '').trim(), line].filter(Boolean).join('\n');
};

const CONFIRMED_APPOINTMENT_STATUSES = new Set(['CONFIRMADO', 'CONFIRMED', 'AGENDADO', 'SCHEDULED']);
const DIGITS_ONLY_REGEX = /\D/g;
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

const getTodayDateString = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const parseAgendaSummary = (value?: string | null) => {
  const raw = String(value || '').trim();
  if (!raw) return { time: '', specialty: '', doctorName: '' };
  const firstSlot = raw.split('|')[0]?.trim() || raw;
  const parts = firstSlot.split('•').map((part) => part.trim()).filter(Boolean);
  return {
    time: parts[0] || '',
    specialty: parts[1] || '',
    doctorName: parts[2] || '',
  };
};

const normalizePatientName = (value?: string | null) => String(value || '').trim().toLowerCase();
const normalizeAppointmentType = (value?: string | null) => String(value || '').trim().toUpperCase();

const isExamAppointment = (value?: string | null) => {
  const normalized = normalizeAppointmentType(value);
  return normalized === 'EXAME' || normalized === 'EXAM';
};

const normalizeNursingAnswers = (answers: unknown) => {
  if (!Array.isArray(answers)) return [];

  return answers
    .map((answer: any, index: number) => {
      const questionLabel = String(answer?.questionLabel || '').trim();
      const responseType = String(answer?.responseType || 'TEXT').trim().toUpperCase();
      if (!questionLabel || !QUESTION_TYPES.has(responseType)) return null;

      const answerValues = Array.isArray(answer?.answerValues)
        ? answer.answerValues.map((value: any) => String(value).trim()).filter(Boolean)
        : [];

      return {
        questionId: answer?.questionId ? String(answer.questionId) : null,
        questionLabel,
        responseType,
        answerText: answer?.answerText !== undefined && answer?.answerText !== null ? String(answer.answerText) : null,
        answerValues,
        answerBoolean: typeof answer?.answerBoolean === 'boolean' ? answer.answerBoolean : null,
        answerNumber: Number.isFinite(Number(answer?.answerNumber)) ? Number(answer.answerNumber) : null,
        orderIndex: Number.isFinite(Number(answer?.orderIndex)) ? Number(answer.orderIndex) : index,
      };
    })
    .filter(Boolean);
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

const resolveNursingTemplateForAppointment = async (branchId: string, appointment: any) => {
  if (!appointment || !isExamAppointment(appointment?.type)) return null;

  const specialty = String(appointment?.specialty || '').trim();
  if (!specialty) return null;

  const normalizedSpecialty = specialty
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const procedures = await prisma.procedure.findMany({
    where: {
      branchId,
      isActive: true,
      OR: [
        { name: { equals: specialty, mode: 'insensitive' } },
        { name: { contains: specialty, mode: 'insensitive' } },
      ],
    },
    include: {
      nursingTemplates: {
        where: { isActive: true },
        include: {
          questions: { include: { options: true } },
        },
      },
    },
  });

  const matchedProcedure = procedures.find((procedure: any) => {
    const normalizedProcedureName = String(procedure?.name || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    return normalizedProcedureName === normalizedSpecialty
      || normalizedProcedureName.includes(normalizedSpecialty)
      || normalizedSpecialty.includes(normalizedProcedureName);
  }) || procedures[0];

  const template = matchedProcedure?.nursingTemplates?.[0];
  return template ? sortTemplate(template) : null;
};

const toConsultationView = (item: any) => ({
  ...item,
  appointmentType: item?.appointment?.type || null,
  triageRequired: Boolean(item?.nursingTemplate),
  nursingTemplate: item?.nursingTemplate || null,
  nursingResponse: item?.nursingResponse
    ? {
        ...item.nursingResponse,
        answers: (item.nursingResponse.answers || [])
          .slice()
          .sort((a: any, b: any) => Number(a.orderIndex || 0) - Number(b.orderIndex || 0)),
      }
    : null,
});

const findTodayAppointmentCandidate = async (params: {
  branchId: string;
  patientName?: string | null;
  doctorName?: string | null;
  agenda?: string | null;
}) => {
  const patientName = normalizePatientName(params.patientName);
  if (!patientName) return null;

  const parsedAgenda = parseAgendaSummary(params.agenda);
  const normalizedDoctor = String(params.doctorName || parsedAgenda.doctorName || '').trim();
  const normalizedSpecialty = String(parsedAgenda.specialty || '').trim();
  const normalizedTime = String(parsedAgenda.time || '').trim();

  const where: any = {
    branchId: params.branchId,
    isActive: true,
    patientName: {
      equals: params.patientName || '',
      mode: 'insensitive',
    },
    date: getTodayDateString(),
  };

  const and: any[] = [];
  if (normalizedDoctor) {
    and.push({ doctorName: { equals: normalizedDoctor, mode: 'insensitive' } });
  }
  if (normalizedSpecialty) {
    and.push({ specialty: { equals: normalizedSpecialty, mode: 'insensitive' } });
  }
  if (normalizedTime) {
    and.push({ time: normalizedTime });
  }
  if (and.length > 0) where.AND = and;

  const candidates = await prisma.appointment.findMany({
    where,
    orderBy: [
      { date: 'asc' },
      { time: 'asc' },
      { createdAt: 'asc' },
    ],
    take: 10,
  });

  return candidates.find((item: any) =>
    CONFIRMED_APPOINTMENT_STATUSES.has(normalizeStatusKey(item?.status || ''))
    || normalizeStatusKey(item?.status || '') === 'EM_ATENDIMENTO',
  ) || candidates[0] || null;
};

export default async function consultationRoutes(app: FastifyInstance) {
  const getLoggedContext = async (request: any) => {
    const userId = (request.user as any)?.id;
    if (!userId) return null;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        sector: { include: { branch: true } },
        doctor: { select: { id: true, name: true } },
      },
    });
    return {
      branchId: user?.sector?.branch?.id || null,
      doctorId: user?.doctor?.id || null,
      doctorName: user?.doctor?.name || null,
    };
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
      summary: 'List consultations',
      tags: ['Consultations'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          convenioStatus: { type: 'string' },
          queueType: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { search, convenioStatus, queueType, limit = 50, offset = 0 } = request.query as any;

    const where: any = { isActive: true, branchId };
    if (context?.doctorId || context?.doctorName) {
      where.AND = [
        {
          OR: [
            ...(context?.doctorId ? [{ doctorId: context.doctorId }] : []),
            ...(context?.doctorName ? [{ doctorName: context.doctorName }] : []),
          ],
        },
      ];
    }
    if (convenioStatus) where.convenioStatus = convenioStatus;
    if (queueType) where.queueType = queueType;
    if (search) {
      const searchOr = [
        { patientName: { contains: search, mode: 'insensitive' } },
        { convenio: { contains: search, mode: 'insensitive' } },
        { doctorName: { contains: search, mode: 'insensitive' } },
      ];
      if (where.AND) {
        where.AND.push({ OR: searchOr });
      } else {
        where.OR = searchOr;
      }
    }

    const [items, total] = await Promise.all([
      prisma.consultation.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
        include: {
          appointment: {
            select: { id: true, specialty: true, type: true, date: true, time: true },
          },
          nursingResponse: {
            include: { answers: true },
          },
        },
      }),
      prisma.consultation.count({ where }),
    ]);

    const enriched = await Promise.all(items.map(async (item: any) => {
      const nursingTemplate = item.appointment
        ? await resolveNursingTemplateForAppointment(branchId, item.appointment)
        : null;
      return toConsultationView({
        ...item,
        nursingTemplate: nursingTemplate
          ? {
              id: nursingTemplate.id,
              name: nursingTemplate.name,
              description: nursingTemplate.description,
              collectHeight: nursingTemplate.collectHeight,
              collectWeight: nursingTemplate.collectWeight,
              collectBloodPressure: nursingTemplate.collectBloodPressure,
              collectTemperature: nursingTemplate.collectTemperature,
              collectHeartRate: nursingTemplate.collectHeartRate,
              collectOxygenSaturation: nursingTemplate.collectOxygenSaturation,
              collectGlucose: nursingTemplate.collectGlucose,
              collectPregnancyCheck: nursingTemplate.collectPregnancyCheck,
              questions: nursingTemplate.questions || [],
            }
          : null,
      });
    }));

    return { items: enriched, total };
  });

  app.get('/:id', {
    schema: {
      summary: 'Get consultation by ID',
      tags: ['Consultations'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const item = await prisma.consultation.findFirst({
      where: {
        id,
        branchId,
        ...((context?.doctorId || context?.doctorName)
          ? {
              OR: [
                ...(context?.doctorId ? [{ doctorId: context.doctorId }] : []),
                ...(context?.doctorName ? [{ doctorName: context.doctorName }] : []),
              ],
            }
          : {}),
      },
      include: {
        appointment: {
          select: { id: true, specialty: true, type: true, date: true, time: true },
        },
        nursingResponse: {
          include: { answers: true },
        },
      },
    });
    if (!item) return reply.code(404).send({ error: 'Consultation not found' });
    const nursingTemplate = item.appointment
      ? await resolveNursingTemplateForAppointment(branchId, item.appointment)
      : null;
    return toConsultationView({
      ...item,
      nursingTemplate: nursingTemplate
        ? {
            id: nursingTemplate.id,
            name: nursingTemplate.name,
            description: nursingTemplate.description,
            collectHeight: nursingTemplate.collectHeight,
            collectWeight: nursingTemplate.collectWeight,
            collectBloodPressure: nursingTemplate.collectBloodPressure,
            collectTemperature: nursingTemplate.collectTemperature,
            collectHeartRate: nursingTemplate.collectHeartRate,
            collectOxygenSaturation: nursingTemplate.collectOxygenSaturation,
            collectGlucose: nursingTemplate.collectGlucose,
            collectPregnancyCheck: nursingTemplate.collectPregnancyCheck,
            questions: nursingTemplate.questions || [],
          }
        : null,
    });
  });

  app.post('/', {
    schema: {
      summary: 'Create consultation',
      tags: ['Consultations'],
      body: {
        type: 'object',
        required: ['patientName'],
        properties: {
          patientName: { type: 'string' },
          appointmentId: { type: 'string' },
          doctorId: { type: 'string' },
          doctorName: { type: 'string' },
          convenio: { type: 'string' },
          convenioStatus: { type: 'string' },
          scheduledFor: { type: 'string' },
          queueType: { type: 'string' },
          agenda: { type: 'string' },
          totem: { type: 'string' },
          queue: { type: 'string' },
          bloodPressure: { type: 'string' },
          heartRate: { type: 'string' },
          temperature: { type: 'string' },
          oxygenSaturation: { type: 'string' },
          weight: { type: 'string' },
          height: { type: 'string' },
          glucose: { type: 'string' },
          bmi: { type: 'string' },
          anamnese: { type: 'string' },
          mainComplaint: { type: 'string' },
          diseaseHistory: { type: 'string' },
          allergies: { type: 'string' },
          medications: { type: 'string' },
          antecedentes: { type: 'string' },
          pregnant: { type: 'string' },
          triageNotes: { type: 'string' },
        },
      },
      response: {
        201: { type: 'object' },
        400: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;
    try {
      const linkedAppointment = data?.appointmentId
        ? await prisma.appointment.findFirst({
            where: { id: String(data.appointmentId), branchId, isActive: true },
            select: { id: true, specialty: true, type: true, date: true, time: true },
          })
        : null;
      const nursingTemplate = linkedAppointment
        ? await resolveNursingTemplateForAppointment(branchId, linkedAppointment)
        : null;
      const defaultQueue = isExamAppointment(linkedAppointment?.type)
        ? (nursingTemplate ? 'Aguardando triagem' : 'Aguardando exame')
        : 'Aguardando atendimento';
      const resolvedQueue = nursingTemplate ? defaultQueue : (data.queue || defaultQueue);

      const isClinicalQueueCreate = canonicalClinicalQueueStatus(data?.queueType) === 'FILA_CLINICA';
      if (isClinicalQueueCreate) {
        if (data?.appointmentId) {
          const existingByAppointment = await prisma.consultation.findFirst({
            where: {
              branchId,
              isActive: true,
              queueType: data.queueType || null,
              appointmentId: data.appointmentId,
            },
            orderBy: { createdAt: 'desc' },
          });
          if (existingByAppointment) {
            return reply.code(201).send(existingByAppointment);
          }
        }

        const existingToday = await prisma.consultation.findFirst({
          where: {
            branchId,
            isActive: true,
            queueType: data.queueType || null,
            patientName: data.patientName || null,
            doctorName: data.doctorName || null,
            agenda: data.agenda || null,
            createdAt: {
              gte: new Date(new Date().setHours(0, 0, 0, 0)),
              lte: new Date(new Date().setHours(23, 59, 59, 999)),
            },
          },
          orderBy: { createdAt: 'desc' },
        });

        if (existingToday) {
          return reply.code(201).send(existingToday);
        }
      }

      const item = await prisma.consultation.create({ data: {
        branchId,
        doctorId: data.doctorId || null,
        appointmentId: data.appointmentId || null,
        doctorName: data.doctorName || null,
        patientName: data.patientName,
        convenio: data.convenio || null,
        convenioStatus: data.convenioStatus || null,
        scheduledFor: data.scheduledFor || null,
        queueType: data.queueType || null,
        agenda: data.agenda || null,
        totem: data.totem || null,
        queue: resolvedQueue,
        bloodPressure: data.bloodPressure || null,
        heartRate: data.heartRate || null,
        temperature: data.temperature || null,
        oxygenSaturation: data.oxygenSaturation || null,
        weight: data.weight || null,
        height: data.height || null,
        glucose: data.glucose || null,
        bmi: data.bmi || null,
        anamnese: data.anamnese || null,
        mainComplaint: data.mainComplaint || null,
        diseaseHistory: data.diseaseHistory || null,
        allergies: data.allergies || null,
        medications: data.medications || null,
        antecedentes: data.antecedentes || null,
        pregnant: data.pregnant || null,
        triageNotes: data.triageNotes || null,
      } });

      return reply.code(201).send(item);
    } catch (err: any) {
      request.log.error({ err }, 'Failed to create consultation');
      return reply.code(400).send({ error: 'Failed to create consultation', details: err.message });
    }
  });

  app.post('/:id/nursing-triage', {
    schema: {
      summary: 'Submit nursing triage for consultation',
      tags: ['Consultations'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object' },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const data = request.body as any;

    const consultation = await prisma.consultation.findFirst({
      where: { id, branchId, isActive: true },
      include: {
        appointment: {
          select: { id: true, specialty: true, type: true, date: true, time: true },
        },
        nursingResponse: true,
      },
    });
    if (!consultation) return reply.code(404).send({ error: 'Consultation not found' });
    if (!consultation.appointment || !isExamAppointment(consultation.appointment.type)) {
      return reply.code(400).send({ error: 'A triagem de enfermagem só está disponível para agendamentos de exame' });
    }

    const nursingTemplate = await resolveNursingTemplateForAppointment(branchId, consultation.appointment);
    if (!nursingTemplate) {
      return reply.code(404).send({ error: 'Não há triagem cadastrada para este procedimento' });
    }

    const answers = normalizeNursingAnswers(data?.answers);
    const answerLabels = new Set(answers.map((answer: any) => answer.questionLabel));

    const missingQuestions = (nursingTemplate.questions || []).filter((question: any) => {
      if (!question?.isRequired) return false;
      return !answerLabels.has(String(question.label || ''));
    });

    const missingStandardFields = [
      nursingTemplate.collectBloodPressure && !String(data?.bloodPressure || consultation.bloodPressure || '').trim() ? 'pressão arterial' : null,
      nursingTemplate.collectHeartRate && !String(data?.heartRate || consultation.heartRate || '').trim() ? 'frequência cardíaca' : null,
      nursingTemplate.collectTemperature && !String(data?.temperature || consultation.temperature || '').trim() ? 'temperatura' : null,
      nursingTemplate.collectOxygenSaturation && !String(data?.oxygenSaturation || consultation.oxygenSaturation || '').trim() ? 'saturação' : null,
      nursingTemplate.collectWeight && !String(data?.weight || consultation.weight || '').trim() ? 'peso' : null,
      nursingTemplate.collectHeight && !String(data?.height || consultation.height || '').trim() ? 'altura' : null,
      nursingTemplate.collectGlucose && !String(data?.glucose || consultation.glucose || '').trim() ? 'glicemia' : null,
      nursingTemplate.collectPregnancyCheck && !String(data?.pregnant || consultation.pregnant || '').trim() ? 'checagem de gestação' : null,
    ].filter(Boolean);

    if (missingQuestions.length > 0 || missingStandardFields.length > 0) {
      return reply.code(400).send({
        error: 'Preencha todos os campos obrigatórios da triagem antes de concluir',
        missingQuestions: missingQuestions.map((question: any) => question.label),
        missingStandardFields,
      });
    }

    const item = await prisma.$transaction(async (tx: any) => {
      if (consultation.nursingResponse?.id) {
        await tx.consultationNursingAnswer.deleteMany({
          where: { responseId: consultation.nursingResponse.id },
        });
        await tx.consultationNursingResponse.delete({
          where: { id: consultation.nursingResponse.id },
        });
      }

      const response = await tx.consultationNursingResponse.create({
        data: {
          consultationId: consultation.id,
          templateId: nursingTemplate.id,
          templateName: nursingTemplate.name,
        },
      });

      if (answers.length > 0) {
        await tx.consultationNursingAnswer.createMany({
          data: answers.map((answer: any) => ({
            responseId: response.id,
            questionId: answer.questionId,
            questionLabel: answer.questionLabel,
            responseType: answer.responseType,
            answerText: answer.answerText,
            answerValues: answer.answerValues,
            answerBoolean: answer.answerBoolean,
            answerNumber: answer.answerNumber,
            orderIndex: answer.orderIndex,
          })),
        });
      }

      return tx.consultation.update({
        where: { id: consultation.id },
        data: {
          bloodPressure: data?.bloodPressure !== undefined ? (data.bloodPressure || null) : consultation.bloodPressure,
          heartRate: data?.heartRate !== undefined ? (data.heartRate || null) : consultation.heartRate,
          temperature: data?.temperature !== undefined ? (data.temperature || null) : consultation.temperature,
          oxygenSaturation: data?.oxygenSaturation !== undefined ? (data.oxygenSaturation || null) : consultation.oxygenSaturation,
          weight: data?.weight !== undefined ? (data.weight || null) : consultation.weight,
          height: data?.height !== undefined ? (data.height || null) : consultation.height,
          glucose: data?.glucose !== undefined ? (data.glucose || null) : consultation.glucose,
          pregnant: data?.pregnant !== undefined ? (data.pregnant || null) : consultation.pregnant,
          triageNotes: data?.triageNotes !== undefined ? (data.triageNotes || null) : consultation.triageNotes,
          triageCompletedAt: new Date(),
          queue: 'Aguardando exame',
        },
        include: {
          appointment: {
            select: { id: true, specialty: true, type: true, date: true, time: true },
          },
          nursingResponse: {
            include: { answers: true },
          },
        },
      });
    });

    return toConsultationView({
      ...item,
      nursingTemplate: {
        id: nursingTemplate.id,
        name: nursingTemplate.name,
        description: nursingTemplate.description,
        collectHeight: nursingTemplate.collectHeight,
        collectWeight: nursingTemplate.collectWeight,
        collectBloodPressure: nursingTemplate.collectBloodPressure,
        collectTemperature: nursingTemplate.collectTemperature,
        collectHeartRate: nursingTemplate.collectHeartRate,
        collectOxygenSaturation: nursingTemplate.collectOxygenSaturation,
        collectGlucose: nursingTemplate.collectGlucose,
        collectPregnancyCheck: nursingTemplate.collectPregnancyCheck,
        questions: nursingTemplate.questions || [],
      },
    });
  });

  app.put('/:id', {
    schema: {
      summary: 'Update consultation',
      tags: ['Consultations'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object' },
      response: {
        200: { type: 'object' },
        400: { type: 'object', additionalProperties: true },
        404: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const data = request.body as any;
    const userId = String((request.user as any)?.id || '');

    try {
      const existing = await prisma.consultation.findFirst({
        where: {
          id,
          branchId,
          ...((context?.doctorId || context?.doctorName)
            ? {
                OR: [
                  ...(context?.doctorId ? [{ doctorId: context.doctorId }] : []),
                  ...(context?.doctorName ? [{ doctorName: context.doctorName }] : []),
                ],
              }
            : {}),
        },
      });
      if (!existing) return reply.code(404).send({ error: 'Consultation not found' });

      const hasQueueStatusChange = typeof data.queue === 'string' && data.queue.trim().length > 0;
      if (hasQueueStatusChange && !canTransitionClinicalQueue(existing.queue, data.queue)) {
        return reply.code(400).send({
          error: 'Invalid status transition',
          message: `Não é permitido mudar de "${existing.queue || 'SEM_STATUS'}" para "${data.queue}".`,
        });
      }

      const nextData = {
        ...data,
        branchId,
        ...(hasQueueStatusChange
          ? { triageNotes: appendQueueStatusAudit(data.triageNotes ?? existing.triageNotes, existing.queue, data.queue, userId || null) }
          : {}),
      };

      const item = await prisma.consultation.update({ where: { id }, data: nextData });

      const movedToDone = hasQueueStatusChange
        && ['ATENDIMENTO_CONCLUIDO', 'EXAME_CONCLUIDO'].includes(canonicalClinicalQueueStatus(data.queue));

      if (movedToDone) {
        try {
          let appointment = null as any;
          const deterministicAppointmentId = String(data?.appointmentId || existing.appointmentId || item.appointmentId || '').trim();

          if (deterministicAppointmentId) {
            appointment = await prisma.appointment.findFirst({
              where: {
                id: deterministicAppointmentId,
                branchId,
                isActive: true,
              },
            });
          }

          if (!appointment) {
            appointment = await findTodayAppointmentCandidate({
              branchId,
              patientName: existing.patientName || item.patientName,
              doctorName: existing.doctorName || item.doctorName,
              agenda: existing.agenda || item.agenda || existing.scheduledFor || item.scheduledFor,
            });
          }

          if (appointment) {
            const appointmentStatusKey = normalizeStatusKey(appointment.status || '');
            if (appointmentStatusKey !== 'REALIZADO') {
              const existingObservation = String(appointment.observations || '').trim();
              const note = `[clinical-finish] ${new Date().toISOString()} consultation:${item.id}`;
              await prisma.appointment.update({
                where: { id: appointment.id },
                data: {
                  status: 'REALIZADO',
                  observations: [existingObservation, note].filter(Boolean).join('\n'),
                },
              });
            }
          }
        } catch (appointmentErr: any) {
          request.log.warn({ err: appointmentErr, consultationId: item.id }, 'Could not sync appointment status to REALIZADO');
        }
      }

      return item;
    } catch (err: any) {
      request.log.error({ err }, 'Failed to update consultation');
      return reply.code(400).send({ error: 'Failed to update consultation', details: err.message });
    }
  });

  app.delete('/:id', {
    schema: {
      summary: 'Delete consultation',
      tags: ['Consultations'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const existing = await prisma.consultation.findFirst({
      where: {
        id,
        branchId,
        ...((context?.doctorId || context?.doctorName)
          ? {
              OR: [
                ...(context?.doctorId ? [{ doctorId: context.doctorId }] : []),
                ...(context?.doctorName ? [{ doctorName: context.doctorName }] : []),
              ],
            }
          : {}),
      },
    });
    if (!existing) return reply.code(404).send({ error: 'Consultation not found' });
    await prisma.consultation.delete({ where: { id } });
    return { message: 'Deleted' };
  });
}
