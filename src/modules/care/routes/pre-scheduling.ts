import { randomBytes } from 'crypto';
import { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { getAnexosStorage } from '../../../lib/storage';
import { createMessagingService } from '../lib/messaging';
import { resolveWhatsAppConfigForBranch } from '../lib/whatsapp-config-resolver';

const CONFIRMED_APPOINTMENT_STATUSES = new Set(['CONFIRMADO', 'CONFIRMED']);
const TELECONSULTATION_OBSERVATION_MARKER = '[MODALIDADE: TELECONSULTA]';

const normalizeStatus = (value?: string | null) => String(value || '').trim().toUpperCase();
const normalizeCpf = (value?: string | null) => String(value || '').replace(/\D/g, '');
const toDateOnly = (value?: string | null) => String(value || '').slice(0, 10);
const toBoolean = (value: unknown): boolean => ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
const isTeleconsultationAppointment = (appointment: any) => String(appointment?.observations || '')
  .toUpperCase()
  .includes(TELECONSULTATION_OBSERVATION_MARKER);

const sanitizeFileName = (value: string) => String(value || 'arquivo')
  .replace(/[^a-zA-Z0-9._-]/g, '_')
  .replace(/_+/g, '_')
  .slice(0, 120);

const decodeBase64 = (raw: string): Buffer => {
  const trimmed = String(raw || '').trim();
  const normalized = trimmed.includes(',') ? trimmed.split(',').pop() || '' : trimmed;
  return Buffer.from(normalized, 'base64');
};

const makePublicToken = () => randomBytes(24).toString('hex');
const PUBLIC_FLOW_WINDOW_MINUTES = 30;

const normalizeComparableText = (value?: string | null) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

const shouldUseAnswerValues = (responseType?: string | null) => {
  const normalized = String(responseType || '').trim().toUpperCase();
  return normalized === 'SINGLE_CHOICE' || normalized === 'MULTIPLE_CHOICE';
};

const isPatientInteractionCompleted = (flow: any) => {
  const status = normalizeStatus(flow?.status);
  return status === 'DOCUMENTS_RECEIVED' || status === 'COMPLETED' || Boolean(flow?.patientSubmittedAt);
};

const isPublicFlowExpired = (flow: any) => {
  if (!flow?.patientAccessExpiresAt) return false;
  if (isPatientInteractionCompleted(flow)) return false;
  return new Date(flow.patientAccessExpiresAt).getTime() <= Date.now();
};

const ensureActivePublicFlow = (flow: any, reply: any) => {
  if (!flow) {
    reply.code(404).send({ error: 'Link inválido ou expirado' });
    return false;
  }

  if (isPublicFlowExpired(flow)) {
    reply.code(410).send({
      error: 'Este link expirou. Solicite um novo envio à clínica.',
      code: 'PUBLIC_LINK_EXPIRED',
      expiredAt: flow.patientAccessExpiresAt,
    });
    return false;
  }

  return true;
};

const resolveAnamnesisTemplateForAppointment = async (branchId: string, appointment: any) => {
  const appointmentType = String(appointment?.type || '').trim().toUpperCase();
  if (appointmentType === 'EXAME' || appointmentType === 'EXAM') return null;

  const specialtyName = String(appointment?.specialty || '').trim();
  if (!specialtyName) return null;

  const procedures = await prisma.procedure.findMany({
    where: {
      branchId,
      isActive: true,
      anamnesisTemplates: {
        some: { isActive: true },
      },
    },
    include: {
      anamnesisTemplates: {
        where: { isActive: true },
        include: {
          questions: {
            include: { options: true },
          },
        },
      },
    },
  });

  const normalizedSpecialty = normalizeComparableText(specialtyName);
  const matchedProcedure = procedures.find((procedure: any) => normalizeComparableText(procedure.name) === normalizedSpecialty);
  if (!matchedProcedure) return null;

  const template = matchedProcedure.anamnesisTemplates?.[0];
  if (!template) return null;

  return {
    id: template.id,
    procedureId: matchedProcedure.id,
    procedureName: matchedProcedure.name,
    name: template.name,
    description: template.description || null,
    questions: (template.questions || [])
      .slice()
      .sort((a: any, b: any) => Number(a.orderIndex || 0) - Number(b.orderIndex || 0))
      .map((question: any) => ({
        id: question.id,
        label: question.label,
        helpText: question.helpText || null,
        responseType: question.responseType,
        placeholder: question.placeholder || null,
        isRequired: Boolean(question.isRequired),
        orderIndex: Number(question.orderIndex || 0),
        options: (question.options || [])
          .slice()
          .sort((a: any, b: any) => Number(a.orderIndex || 0) - Number(b.orderIndex || 0))
          .map((option: any) => ({
            id: option.id,
            label: option.label,
            value: option.value,
            orderIndex: Number(option.orderIndex || 0),
          })),
      })),
  };
};

export default async function preSchedulingRoutes(app: FastifyInstance) {
  const getLoggedUser = async (request: any) => {
    const userId = (request.user as any)?.id;
    if (!userId) return null;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });
    return user || null;
  };

  const ensureAuthenticated = async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
      return true;
    } catch {
      reply.code(401).send({ error: 'Unauthorized' });
      return false;
    }
  };

  const ensureFlowForAppointment = async (appointmentId: string, branchId: string, userId?: string) => {
    const appointment = await prisma.appointment.findFirst({
      where: { id: appointmentId, branchId, isActive: true },
    });

    if (!appointment) {
      return { error: 'Appointment not found', statusCode: 404 as const };
    }

    if (!CONFIRMED_APPOINTMENT_STATUSES.has(normalizeStatus(appointment.status))) {
      return { error: 'Only confirmed appointments can enter pre-scheduling', statusCode: 400 as const };
    }

    const linkedPatient = appointment.patientId
      ? await prisma.patient.findFirst({
          where: { id: appointment.patientId, branchId, isActive: true },
          select: { id: true, name: true, cpf: true, cellphone: true, phone: true },
        })
      : null;

    const flow = await prisma.preSchedulingFlow.upsert({
      where: { appointmentId: appointment.id },
      update: {
        branchId,
        patientId: appointment.patientId || linkedPatient?.id || null,
        patientName: appointment.patientName || linkedPatient?.name || null,
        patientCpf: normalizeCpf(appointment.patientCpf || linkedPatient?.cpf || ''),
        patientPhone: linkedPatient?.cellphone || linkedPatient?.phone || null,
      },
      create: {
        branchId,
        appointmentId: appointment.id,
        patientId: appointment.patientId || linkedPatient?.id || null,
        patientName: appointment.patientName || linkedPatient?.name || null,
        patientCpf: normalizeCpf(appointment.patientCpf || linkedPatient?.cpf || ''),
        patientPhone: linkedPatient?.cellphone || linkedPatient?.phone || null,
        source: 'COMMON',
        publicToken: makePublicToken(),
        linkSentByUserId: userId || null,
      },
    });

    return { appointment, flow };
  };

  app.get('/', {
    schema: {
      summary: 'List pre-scheduling queue items (confirmed appointments)',
      tags: ['PreScheduling'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          status: { type: 'string' },
          dateFrom: { type: 'string' },
          dateTo: { type: 'string' },
          includeResolved: { type: 'boolean' },
          resolvedOnly: { type: 'boolean' },
          limit: { type: 'number', default: 500 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    if (!(await ensureAuthenticated(request, reply))) return;

    const user = await getLoggedUser(request);
    const branchId = user?.sector?.branch?.id || null;
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { search, status, dateFrom, dateTo, includeResolved, resolvedOnly, limit = 500, offset = 0 } = request.query as any;
    const statusFilter = String(status || '').trim().toUpperCase();
    const normalizedSearch = String(search || '').trim().toLowerCase();
    const includeResolvedFlag = toBoolean(includeResolved);
    const resolvedOnlyFlag = toBoolean(resolvedOnly);

    const where: any = {
      branchId,
      isActive: true,
      OR: [
        { status: 'CONFIRMADO' },
        { status: 'CONFIRMED' },
      ],
    };

    if (dateFrom || dateTo) {
      where.date = {};
      if (dateFrom) where.date.gte = String(dateFrom);
      if (dateTo) where.date.lte = String(dateTo);
    }

    const appointments = await prisma.appointment.findMany({
      where,
      orderBy: [
        { date: 'asc' },
        { time: 'asc' },
        { createdAt: 'desc' },
      ],
      take: Number(limit),
      skip: Number(offset),
    });

    const appointmentIds = appointments.map((item: any) => String(item.id));
    const flows = appointmentIds.length
      ? await prisma.preSchedulingFlow.findMany({
          where: { appointmentId: { in: appointmentIds } },
          include: {
            documents: true,
            anamnesisResponse: {
              include: {
                answers: true,
              },
            },
          },
        })
      : [];

    const flowByAppointmentId = new Map<string, any>();
    flows.forEach((flow: any) => {
      flowByAppointmentId.set(String(flow.appointmentId), flow);
    });

    const mappedItems = await Promise.all(appointments
      .map(async (appointment: any) => {
        const flow = flowByAppointmentId.get(String(appointment.id));
        const anamnesisTemplate = await resolveAnamnesisTemplateForAppointment(branchId, appointment);
        const itemStatus = String(flow?.status || 'PENDING').toUpperCase();
        const isTeleconsultation = isTeleconsultationAppointment(appointment);
        const teleconsultationLinkSent = Boolean(flow?.completedAt);
        const isResolved = itemStatus === 'COMPLETED';
        return {
          id: String(appointment.id),
          appointmentId: String(appointment.id),
          patientId: appointment.patientId || null,
          patientName: appointment.patientName || flow?.patientName || '',
          patientCpf: normalizeCpf(appointment.patientCpf || flow?.patientCpf || ''),
          patientPhone: flow?.patientPhone || null,
          source: String(flow?.source || 'COMMON').toUpperCase(),
          doctorName: appointment.doctorName || null,
          specialty: appointment.specialty || null,
          convenio: appointment.convenio || null,
          date: toDateOnly(appointment.date),
          time: appointment.time || null,
          appointmentStatus: appointment.status || null,
          authorizationStatus: appointment.authorizationStatus || 'PENDING',
          preSchedulingStatus: itemStatus,
          flowId: flow?.id || null,
          linkSentAt: flow?.linkSentAt || null,
          preAuthorizedAt: flow?.preAuthorizedAt || null,
          guideNumber: flow?.guideNumber || null,
          docsCount: Array.isArray(flow?.documents) ? flow.documents.length : 0,
          hasAnamnesis: Boolean(anamnesisTemplate),
          anamnesisAnswered: Boolean(flow?.anamnesisResponse?.submittedAt),
          anamnesisAnswersCount: Array.isArray(flow?.anamnesisResponse?.answers) ? flow.anamnesisResponse.answers.length : 0,
          tokenAvailable: Boolean(flow?.publicToken),
          isTeleconsultation,
          teleconsultationLinkSent,
          isResolved,
        };
      }));

    const items = mappedItems.filter((item: any) => {
        if (resolvedOnlyFlag && !item.isResolved) return false;
        if (!includeResolvedFlag && !resolvedOnlyFlag && item.isResolved) return false;
        if (statusFilter && item.preSchedulingStatus !== statusFilter) return false;
        if (!normalizedSearch) return true;
        return [
          item.patientName,
          item.patientCpf,
          item.doctorName,
          item.specialty,
          item.convenio,
          item.date,
          item.time,
        ].some((value) => String(value || '').toLowerCase().includes(normalizedSearch));
      });

    return reply.send({ total: items.length, items });
  });

  app.post('/:appointmentId/pre-authorize', {
    schema: {
      summary: 'Pre-authorize confirmed appointment before reception checklist',
      tags: ['PreScheduling'],
      params: {
        type: 'object',
        required: ['appointmentId'],
        properties: { appointmentId: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          guideNumber: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    if (!(await ensureAuthenticated(request, reply))) return;

    const user = await getLoggedUser(request);
    const branchId = user?.sector?.branch?.id || null;
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const userId = String((request.user as any)?.id || '');
    const { appointmentId } = request.params as { appointmentId: string };
    const { guideNumber, notes } = (request.body || {}) as { guideNumber?: string; notes?: string };

    const ensured = await ensureFlowForAppointment(appointmentId, branchId, userId);
    if ((ensured as any).error) {
      return reply.code((ensured as any).statusCode).send({ error: (ensured as any).error });
    }

    const { flow, appointment } = ensured as any;
    if (flow?.preAuthorizedAt) {
      return reply.code(400).send({ error: 'Este agendamento já foi pré-autorizado' });
    }
    const nextStatus = 'PRE_AUTHORIZED';

    const updatedFlow = await prisma.preSchedulingFlow.update({
      where: { id: flow.id },
      data: {
        status: nextStatus,
        preAuthorizedAt: new Date(),
        guideNumber: guideNumber || flow.guideNumber || null,
        preAuthorizationNotes: notes || null,
        completedAt: null,
      },
    });

    await prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        authorizationStatus: 'AUTHORIZED',
        authorizationNotes: notes || null,
        authorizedAt: new Date(),
      },
    });

    return reply.send({
      message: 'Pré-autorização registrada com sucesso',
      item: updatedFlow,
    });
  });

  app.post('/:appointmentId/send-link', {
    schema: {
      summary: 'Send whatsapp link for patient document upload',
      tags: ['PreScheduling'],
      params: {
        type: 'object',
        required: ['appointmentId'],
        properties: { appointmentId: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          notes: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    if (!(await ensureAuthenticated(request, reply))) return;

    const user = await getLoggedUser(request);
    const branchId = user?.sector?.branch?.id || null;
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { appointmentId } = request.params as { appointmentId: string };
    const { notes } = (request.body || {}) as { notes?: string };
    const userId = String((request.user as any)?.id || '');

    const ensured = await ensureFlowForAppointment(appointmentId, branchId, userId);
    if ((ensured as any).error) {
      return reply.code((ensured as any).statusCode).send({ error: (ensured as any).error });
    }

    const { flow, appointment } = ensured as any;
    const flowWithProgress = await prisma.preSchedulingFlow.findUnique({
      where: { id: flow.id },
      include: {
        documents: { select: { id: true } },
        anamnesisResponse: { select: { id: true } },
      },
    });

    const currentStatus = String(flowWithProgress?.status || flow?.status || '').toUpperCase();
    const alreadySubmitted = Boolean(flowWithProgress?.patientSubmittedAt);
    const documentsCount = Array.isArray(flowWithProgress?.documents) ? flowWithProgress.documents.length : 0;
    const hasDocuments = documentsCount > 0;
    const hasAnamnesisResponse = Boolean(flowWithProgress?.anamnesisResponse?.id);

    const anamnesisTemplate = await resolveAnamnesisTemplateForAppointment(branchId, appointment);
    if (currentStatus === 'COMPLETED' || currentStatus === 'DOCUMENTS_RECEIVED' || alreadySubmitted || hasDocuments || hasAnamnesisResponse) {
      return reply.code(400).send({ error: 'Documentos já recebidos/respondidos. Não é possível reenviar link de docs.' });
    }

    const token = makePublicToken();
    const publicBase = String(process.env.PUBLIC_APP_URL);
    const publicUrl = `${publicBase}/pre-atendimento/documentos/${token}`;
    const mockMessage = [
      `Olá, ${flow.patientName || appointment.patientName || 'paciente'}!`,
      anamnesisTemplate
        ? 'Para adiantar seu atendimento, valide sua identidade e envie seus documentos, além de responder a anamnese neste link:'
        : 'Para adiantar seu atendimento, envie seus documentos neste link:',
      publicUrl,
      notes ? `Observação: ${notes}` : null,
    ].filter(Boolean).join(' ');

    const updatedFlow = await prisma.preSchedulingFlow.update({
      where: { id: flow.id },
      data: {
        status: 'WAITING_PATIENT_DOCUMENTS',
        publicToken: token,
        linkSentAt: new Date(),
        linkSentByUserId: userId || null,
        patientVerifiedAt: null,
        patientVerifiedCpf: null,
        patientVerifiedName: null,
        patientVerifiedTrust: null,
        patientAccessExpiresAt: null,
        patientSubmittedAt: null,
        anamnesisSentAt: anamnesisTemplate ? new Date() : flow.anamnesisSentAt || null,
        anamnesisSentByUserId: anamnesisTemplate ? (userId || null) : flow.anamnesisSentByUserId || null,
        linkMockMessage: mockMessage,
      },
    });

    let whatsappResult: any = {
      provider: 'mock',
      to: flow.patientPhone || null,
      message: mockMessage,
    };

    const whatsappConfig = await prisma.whatsAppConfig.findUnique({ where: { branchId } });
    const resolvedMessagingConfig = await resolveWhatsAppConfigForBranch(branchId, {
      requireActive: true,
      requireCredentials: true,
    });
    const apiKey = resolvedMessagingConfig?.accountSid;
    const appName = resolvedMessagingConfig?.authToken;
    const sourceNumber = resolvedMessagingConfig?.fromNumber;

    if ((whatsappConfig?.isActive || resolvedMessagingConfig?.isInherited) && flow.patientPhone && apiKey && appName && sourceNumber) {
      const messageLog = await prisma.whatsAppMessageLog.create({
        data: {
          branchId,
          appointmentId: appointment.id,
          patientName: flow.patientName || appointment.patientName || null,
          patientPhone: flow.patientPhone,
          messageType: 'APPOINTMENT_CREATED',
          message: mockMessage,
          status: 'PENDING',
        },
      });

      const messaging = createMessagingService({ accountSid: apiKey, authToken: appName, fromNumber: sourceNumber, appId: resolvedMessagingConfig?.appId });
      const sendResult = await messaging.sendTextMessage({
        to: flow.patientPhone,
        message: mockMessage,
      });

      if (sendResult.status === 'success') {
        await prisma.whatsAppMessageLog.update({
          where: { id: messageLog.id },
          data: {
            status: 'SENT',
            providerMessageId: sendResult.messageId || null,
            sentAt: new Date(),
          },
        });
      } else {
        await prisma.whatsAppMessageLog.update({
          where: { id: messageLog.id },
          data: {
            status: 'FAILED',
            errorMessage: sendResult.error || 'Falha ao enviar mensagem de link de documentos.',
          },
        });
      }

      whatsappResult = {
        provider: 'meta',
        to: flow.patientPhone,
        message: mockMessage,
        status: sendResult.status,
        messageId: sendResult.messageId || null,
        error: sendResult.error || null,
        logId: messageLog.id,
      };
    }

    return reply.send({
      message: 'Link gerado com sucesso',
      item: updatedFlow,
      whatsapp: whatsappResult,
      publicUrl,
      hasAnamnesis: Boolean(anamnesisTemplate),
    });
  });

  app.get('/:appointmentId/documents', {
    schema: {
      summary: 'List uploaded documents for an appointment pre-scheduling flow',
      tags: ['PreScheduling'],
      params: {
        type: 'object',
        required: ['appointmentId'],
        properties: { appointmentId: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    if (!(await ensureAuthenticated(request, reply))) return;

    const user = await getLoggedUser(request);
    const branchId = user?.sector?.branch?.id || null;
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { appointmentId } = request.params as { appointmentId: string };

    const flow = await prisma.preSchedulingFlow.findFirst({
      where: { appointmentId, branchId },
      include: {
        documents: {
          orderBy: { uploadedAt: 'desc' },
        },
        appointment: true,
        anamnesisResponse: {
          include: {
            answers: {
              orderBy: { orderIndex: 'asc' },
            },
          },
        },
      },
    });

    if (!flow) return reply.send({ items: [], anamnesis: null });

    const anamnesisTemplate = flow.appointment
      ? await resolveAnamnesisTemplateForAppointment(branchId, flow.appointment)
      : null;

    return reply.send({
      items: flow.documents.map((doc: any) => ({
        id: doc.id,
        documentType: doc.documentType,
        fileName: doc.fileName,
        mimeType: doc.mimeType,
        sizeBytes: doc.sizeBytes,
        uploadedAt: doc.uploadedAt,
      })),
      anamnesis: anamnesisTemplate ? {
        templateId: anamnesisTemplate.id,
        templateName: anamnesisTemplate.name,
        answered: Boolean(flow.anamnesisResponse?.submittedAt),
        answeredAt: flow.anamnesisResponse?.submittedAt || null,
        answers: (flow.anamnesisResponse?.answers || []).map((answer: any) => ({
          id: answer.id,
          questionLabel: answer.questionLabel,
          responseType: answer.responseType,
          answerText: answer.answerText || null,
          answerValues: answer.answerValues || [],
          answerBoolean: answer.answerBoolean,
          answerNumber: answer.answerNumber,
          orderIndex: answer.orderIndex,
        })),
      } : null,
    });
  });

  app.get('/:appointmentId/documents/:documentId/view', {
    schema: {
      summary: 'View uploaded document for an appointment pre-scheduling flow',
      tags: ['PreScheduling'],
      params: {
        type: 'object',
        required: ['appointmentId', 'documentId'],
        properties: {
          appointmentId: { type: 'string' },
          documentId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    if (!(await ensureAuthenticated(request, reply))) return;

    const user = await getLoggedUser(request);
    const branchId = user?.sector?.branch?.id || null;
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { appointmentId, documentId } = request.params as { appointmentId: string; documentId: string };

    const flow = await prisma.preSchedulingFlow.findFirst({
      where: { appointmentId, branchId },
      include: {
        documents: {
          where: { id: documentId },
          take: 1,
        },
      },
    });

    if (!flow) return reply.code(404).send({ error: 'Fluxo de pré-agendamento não encontrado' });
    const document = flow.documents?.[0];
    if (!document) return reply.code(404).send({ error: 'Documento não encontrado' });

    const storageDoc = getAnexosStorage();
    const fileExists = await storageDoc.exists(document.gcsObjectName);
    if (!fileExists) return reply.code(404).send({ error: 'Arquivo não encontrado no storage' });

    reply.header('Content-Type', document.mimeType || 'application/octet-stream');
    reply.header('Content-Disposition', `inline; filename="${document.fileName || 'documento'}"`);
    return reply.send(storageDoc.createReadStream(document.gcsObjectName));
  });

  app.post('/:appointmentId/review-documents', {
    schema: {
      summary: 'Review patient documents (approve or request resubmission)',
      tags: ['PreScheduling'],
      params: {
        type: 'object',
        required: ['appointmentId'],
        properties: { appointmentId: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['APPROVE', 'REQUEST_RESUBMISSION'] },
        },
      },
    },
  }, async (request, reply) => {
    if (!(await ensureAuthenticated(request, reply))) return;

    const user = await getLoggedUser(request);
    const branchId = user?.sector?.branch?.id || null;
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { appointmentId } = request.params as { appointmentId: string };
    const { action } = request.body as { action: 'APPROVE' | 'REQUEST_RESUBMISSION' };

    const flow = await prisma.preSchedulingFlow.findFirst({
      where: { appointmentId, branchId },
      include: {
        documents: { select: { id: true } },
        appointment: true,
        anamnesisResponse: { select: { id: true } },
      },
    });

    if (!flow) return reply.code(404).send({ error: 'Fluxo de pré-agendamento não encontrado' });
    const anamnesisTemplate = flow.appointment
      ? await resolveAnamnesisTemplateForAppointment(branchId, flow.appointment)
      : null;
    const hasDocuments = Array.isArray(flow.documents) && flow.documents.length > 0;
    const hasAnamnesisResponse = Boolean(flow.anamnesisResponse?.id);

    if (!hasDocuments && !(anamnesisTemplate && hasAnamnesisResponse)) {
      return reply.code(400).send({ error: 'Não há documentos ou anamnese respondida para revisar' });
    }

    const nextStatus = action === 'APPROVE'
      ? 'DOCUMENTS_RECEIVED'
      : 'WAITING_PATIENT_DOCUMENTS';
    const updated = await prisma.preSchedulingFlow.update({
      where: { id: flow.id },
      data: {
        status: nextStatus,
        completedAt: null,
      },
    });

    return reply.send({
      message: action === 'APPROVE'
        ? 'Documentos revisados e aprovados com sucesso'
        : 'Reenvio de documentos solicitado com sucesso',
      status: updated.status,
      item: updated,
    });
  });

  app.post('/:appointmentId/manual-finalize', {
    schema: {
      summary: 'Finalize teleconsultation pre-scheduling flow manually',
      tags: ['PreScheduling'],
      params: {
        type: 'object',
        required: ['appointmentId'],
        properties: { appointmentId: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    if (!(await ensureAuthenticated(request, reply))) return;

    const user = await getLoggedUser(request);
    const branchId = user?.sector?.branch?.id || null;
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { appointmentId } = request.params as { appointmentId: string };
    const flow = await prisma.preSchedulingFlow.findFirst({
      where: { appointmentId, branchId },
      include: {
        appointment: true,
      },
    });

    if (!flow) return reply.code(404).send({ error: 'Fluxo de pré-agendamento não encontrado' });
    if (!isTeleconsultationAppointment(flow.appointment)) {
      return reply.code(400).send({ error: 'Finalização manual disponível apenas para teleconsulta' });
    }
    if (!flow.preAuthorizedAt) {
      return reply.code(400).send({ error: 'Pré-autorização pendente para este agendamento' });
    }
    if (String(flow.status || '').toUpperCase() === 'CANCELED') {
      return reply.code(400).send({ error: 'Fluxo cancelado não pode ser finalizado' });
    }
    if (flow.completedAt) {
      return reply.send({
        message: 'Fluxo já finalizado manualmente',
        status: flow.status,
        completedAt: flow.completedAt,
      });
    }

    const updated = await prisma.preSchedulingFlow.update({
      where: { id: flow.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });

    return reply.send({
      message: 'Fluxo finalizado manualmente com sucesso',
      status: updated.status,
      completedAt: updated.completedAt,
    });
  });

  app.get('/public/:token', {
    schema: {
      summary: 'Get public pre-scheduling upload page metadata',
      tags: ['PreSchedulingPublic'],
      params: {
        type: 'object',
        required: ['token'],
        properties: { token: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { token } = request.params as { token: string };

    const flow = await prisma.preSchedulingFlow.findFirst({
      where: { publicToken: token },
      include: {
        appointment: true,
        documents: {
          orderBy: { uploadedAt: 'desc' },
        },
        anamnesisResponse: {
          include: {
            answers: {
              orderBy: { orderIndex: 'asc' },
            },
          },
        },
      },
    });

    if (!ensureActivePublicFlow(flow, reply)) return;

    const anamnesisTemplate = flow.appointment
      ? await resolveAnamnesisTemplateForAppointment(String(flow.branchId || ''), flow.appointment)
      : null;

    return reply.send({
      id: flow.id,
      branchId: flow.branchId,
      patientName: flow.patientName || flow.appointment?.patientName || 'Paciente',
      appointment: {
        specialty: flow.appointment?.specialty || null,
        doctorName: flow.appointment?.doctorName || null,
        date: flow.appointment?.date || null,
        time: flow.appointment?.time || null,
      },
      status: flow.status,
      verified: Boolean(flow.patientVerifiedAt),
      verificationExpiresAt: flow.patientAccessExpiresAt || null,
      interactionCompleted: isPatientInteractionCompleted(flow),
      documentsCount: flow.documents.length,
      documents: flow.documents.map((doc: any) => ({
        id: doc.id,
        documentType: doc.documentType,
        fileName: doc.fileName,
        uploadedAt: doc.uploadedAt,
      })),
      anamnesis: anamnesisTemplate ? {
        templateId: anamnesisTemplate.id,
        name: anamnesisTemplate.name,
        description: anamnesisTemplate.description,
        answered: Boolean(flow.anamnesisResponse?.submittedAt),
        answeredAt: flow.anamnesisResponse?.submittedAt || null,
        questions: anamnesisTemplate.questions,
        answers: (flow.anamnesisResponse?.answers || []).map((answer: any) => ({
          questionId: answer.questionId || null,
          questionLabel: answer.questionLabel,
          responseType: answer.responseType,
          answerText: answer.answerText || null,
          answerValues: answer.answerValues || [],
          answerBoolean: answer.answerBoolean,
          answerNumber: answer.answerNumber,
          orderIndex: answer.orderIndex,
        })),
      } : null,
    });
  });

  app.post('/public/:token/verify', {
    schema: {
      summary: 'Verify patient identity (CPF + facial) before document upload',
      tags: ['PreSchedulingPublic'],
      params: {
        type: 'object',
        required: ['token'],
        properties: { token: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['recognizedCpf'],
        properties: {
          recognizedCpf: { type: 'string' },
          recognizedName: { type: 'string' },
          recognizedTrust: { type: 'number' },
        },
      },
    },
  }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const {
      recognizedCpf,
      recognizedName,
      recognizedTrust,
    } = request.body as {
      recognizedCpf: string;
      recognizedName?: string;
      recognizedTrust?: number;
    };

    const flow = await prisma.preSchedulingFlow.findFirst({
      where: { publicToken: token },
      include: { appointment: true },
    });

    if (!ensureActivePublicFlow(flow, reply)) return;

    if (flow.patientVerifiedAt) {
      return reply.code(400).send({ error: 'A identidade já foi validada para este link' });
    }

    const normalizedRecognizedCpf = normalizeCpf(recognizedCpf);
    if (!normalizedRecognizedCpf) {
      return reply.code(400).send({ error: 'Não foi possível identificar o CPF pela biometria facial' });
    }

    if (normalizeCpf(flow.patientCpf || '') && normalizeCpf(flow.patientCpf || '') !== normalizedRecognizedCpf) {
      return reply.code(400).send({ error: 'CPF não confere com o agendamento' });
    }

    const updated = await prisma.preSchedulingFlow.update({
      where: { id: flow.id },
      data: {
        patientVerifiedAt: new Date(),
        patientVerifiedCpf: normalizedRecognizedCpf,
        patientVerifiedName: recognizedName || null,
        patientVerifiedTrust: Number.isFinite(Number(recognizedTrust)) ? Number(recognizedTrust) : null,
        patientAccessExpiresAt: new Date(Date.now() + (PUBLIC_FLOW_WINDOW_MINUTES * 60 * 1000)),
        status: flow.status === 'PENDING' ? 'WAITING_PATIENT_DOCUMENTS' : flow.status,
      },
    });

    return reply.send({
      verified: true,
      trust: updated.patientVerifiedTrust,
      patientName: updated.patientVerifiedName,
      verificationExpiresAt: updated.patientAccessExpiresAt,
    });
  });

  app.post('/public/:token/upload', {
    schema: {
      summary: 'Upload patient document to GCS for pre-scheduling flow',
      tags: ['PreSchedulingPublic'],
      params: {
        type: 'object',
        required: ['token'],
        properties: { token: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['documentType', 'fileName', 'fileBase64'],
        properties: {
          cpf: { type: 'string' },
          documentType: { type: 'string' },
          fileName: { type: 'string' },
          mimeType: { type: 'string' },
          fileBase64: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const payload = request.body as {
      cpf: string;
      documentType: string;
      fileName: string;
      mimeType?: string;
      fileBase64: string;
    };

    const flow = await prisma.preSchedulingFlow.findFirst({
      where: { publicToken: token },
    });

    if (!ensureActivePublicFlow(flow, reply)) return;

    if (isPatientInteractionCompleted(flow)) {
      return reply.code(400).send({ error: 'Este envio já foi finalizado e não pode receber novos anexos' });
    }

    const normalizedCpf = normalizeCpf(payload.cpf || flow.patientVerifiedCpf || '');
    if (!normalizedCpf) return reply.code(400).send({ error: 'Validação facial pendente para identificar CPF' });

    if (!flow.patientVerifiedAt || normalizeCpf(flow.patientVerifiedCpf || '') !== normalizedCpf) {
      return reply.code(400).send({ error: 'Validação facial pendente para esse CPF' });
    }

    const buffer = decodeBase64(payload.fileBase64);
    if (!buffer || buffer.length === 0) {
      return reply.code(400).send({ error: 'Arquivo inválido' });
    }

    const safeFileName = sanitizeFileName(payload.fileName || 'documento');
    const objectName = `pre-scheduling/${String(flow.branchId || 'sem-filial')}/${flow.id}/${Date.now()}-${safeFileName}`;

    await getAnexosStorage().save(objectName, buffer, {
      contentType: payload.mimeType || 'application/octet-stream',
      metadata: {
        flowId: flow.id,
        documentType: payload.documentType,
        cpf: normalizedCpf,
      },
    });

    const created = await prisma.preSchedulingDocument.create({
      data: {
        flowId: flow.id,
        documentType: payload.documentType,
        fileName: safeFileName,
        mimeType: payload.mimeType || null,
        sizeBytes: buffer.length,
        gcsObjectName: objectName,
        uploadedByType: 'PATIENT',
        uploadedByCpf: normalizedCpf,
      },
    });

    await prisma.preSchedulingFlow.update({
      where: { id: flow.id },
      data: {
        status: 'WAITING_PATIENT_DOCUMENTS',
      },
    });

    return reply.send({
      message: 'Documento enviado com sucesso',
      document: {
        id: created.id,
        documentType: created.documentType,
        fileName: created.fileName,
        uploadedAt: created.uploadedAt,
      },
    });
  });

  app.post('/public/:token/anamnesis', {
    schema: {
      summary: 'Submit public pre-scheduling anamnesis answers',
      tags: ['PreSchedulingPublic'],
      params: {
        type: 'object',
        required: ['token'],
        properties: { token: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['answers'],
        properties: {
          answers: { type: 'array' },
        },
      },
    },
  }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const { answers } = request.body as { answers: any[] };

    const flow = await prisma.preSchedulingFlow.findFirst({
      where: { publicToken: token },
      include: {
        appointment: true,
      },
    });

    if (!ensureActivePublicFlow(flow, reply)) return;
    if (!flow.patientVerifiedAt) {
      return reply.code(400).send({ error: 'Validação de identidade pendente' });
    }
    if (isPatientInteractionCompleted(flow)) {
      return reply.code(400).send({ error: 'Esta anamnese já foi finalizada e não pode ser alterada' });
    }

    const template = flow.appointment
      ? await resolveAnamnesisTemplateForAppointment(String(flow.branchId || ''), flow.appointment)
      : null;
    if (!template) {
      return reply.code(404).send({ error: 'Não há anamnese configurada para este procedimento' });
    }
    if (flow.anamnesisResponse) {
      return reply.code(400).send({ error: 'A anamnese já foi respondida para este link' });
    }

    const answerMap = new Map<string, any>();
    if (Array.isArray(answers)) {
      answers.forEach((answer: any) => {
        const questionId = String(answer?.questionId || '').trim();
        if (questionId) answerMap.set(questionId, answer);
      });
    }

    for (const question of template.questions) {
      const payload = answerMap.get(String(question.id));
      if (!question.isRequired) continue;

      const hasText = String(payload?.answerText || '').trim().length > 0;
      const hasValues = Array.isArray(payload?.answerValues) && payload.answerValues.some((value: any) => String(value || '').trim().length > 0);
      const hasBoolean = typeof payload?.answerBoolean === 'boolean';
      const hasNumber = Number.isFinite(Number(payload?.answerNumber));

      const isFilled = shouldUseAnswerValues(question.responseType)
        ? hasValues
        : question.responseType === 'BOOLEAN'
          ? hasBoolean
          : question.responseType === 'NUMBER'
            ? hasNumber
            : hasText;

      if (!isFilled) {
        return reply.code(400).send({ error: `A pergunta obrigatória "${question.label}" precisa ser respondida` });
      }
    }

    const saved = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.preSchedulingAnamnesisAnswer.deleteMany({
        where: {
          response: {
            flowId: flow.id,
          },
        },
      });

      const response = await tx.preSchedulingAnamnesisResponse.upsert({
        where: { flowId: flow.id },
        update: {
          templateId: template.id,
          templateName: template.name,
          submittedAt: new Date(),
        },
        create: {
          flowId: flow.id,
          templateId: template.id,
          templateName: template.name,
          submittedAt: new Date(),
        },
      });

      for (const question of template.questions) {
        const payload = answerMap.get(String(question.id)) || {};
        const answerValues = shouldUseAnswerValues(question.responseType)
          ? (Array.isArray(payload?.answerValues) ? payload.answerValues.map((value: any) => String(value).trim()).filter(Boolean) : [])
          : [];

        await tx.preSchedulingAnamnesisAnswer.create({
          data: {
            responseId: response.id,
            questionId: question.id,
            questionLabel: question.label,
            responseType: question.responseType,
            answerText: !shouldUseAnswerValues(question.responseType) && payload?.answerText !== undefined
              ? String(payload.answerText || '').trim() || null
              : null,
            answerValues,
            answerBoolean: typeof payload?.answerBoolean === 'boolean' ? payload.answerBoolean : null,
            answerNumber: Number.isFinite(Number(payload?.answerNumber)) ? Number(payload.answerNumber) : null,
            orderIndex: Number(question.orderIndex || 0),
          },
        });
      }

      await tx.preSchedulingFlow.update({
        where: { id: flow.id },
        data: {
          status: flow.status === 'PENDING' ? 'WAITING_PATIENT_DOCUMENTS' : flow.status,
        },
      });

      return tx.preSchedulingAnamnesisResponse.findUnique({
        where: { id: response.id },
        include: {
          answers: {
            orderBy: { orderIndex: 'asc' },
          },
        },
      });
    });

    return reply.send({
      message: 'Anamnese enviada com sucesso',
      item: saved,
    });
  });

  app.post('/public/:token/finalize', {
    schema: {
      summary: 'Finalize patient document sending for pre-scheduling flow',
      tags: ['PreSchedulingPublic'],
      params: {
        type: 'object',
        required: ['token'],
        properties: { token: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          patientComplaints: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const { patientComplaints } = (request.body || {}) as { patientComplaints?: string };

    const flow = await prisma.preSchedulingFlow.findFirst({
      where: { publicToken: token },
      include: {
        documents: { select: { id: true } },
        appointment: true,
        anamnesisResponse: { select: { id: true } },
      },
    });

    if (!ensureActivePublicFlow(flow, reply)) return;

    if (!flow.patientVerifiedAt) {
      return reply.code(400).send({ error: 'Validação de identidade pendente' });
    }
    if (isPatientInteractionCompleted(flow)) {
      return reply.code(400).send({ error: 'Este envio já foi finalizado' });
    }

    const hasDocuments = Array.isArray(flow.documents) && flow.documents.length > 0;
    const anamnesisTemplate = flow.appointment
      ? await resolveAnamnesisTemplateForAppointment(String(flow.branchId || ''), flow.appointment)
      : null;
    const hasAnamnesisResponse = Boolean(flow.anamnesisResponse?.id);

    if (anamnesisTemplate && !hasAnamnesisResponse) {
      return reply.code(400).send({ error: 'Responda a anamnese antes de finalizar' });
    }

    if (!hasDocuments && !hasAnamnesisResponse) {
      return reply.code(400).send({ error: 'Envie ao menos um documento ou responda a anamnese antes de finalizar' });
    }

    const updated = await prisma.preSchedulingFlow.update({
      where: { id: flow.id },
      data: {
        status: 'DOCUMENTS_RECEIVED',
        patientSubmittedAt: new Date(),
        patientComplaints: patientComplaints ? String(patientComplaints).trim() : null,
      },
    });

    return reply.send({
      message: 'Envio finalizado com sucesso. Documentos prontos para revisão da clínica.',
      status: updated.status,
      patientSubmittedAt: updated.patientSubmittedAt,
    });
  });
}
