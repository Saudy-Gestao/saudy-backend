import { randomBytes } from 'crypto';
import { Storage } from '@google-cloud/storage';
import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

const CONFIRMED_APPOINTMENT_STATUSES = new Set(['CONFIRMADO', 'CONFIRMED']);
const GCS_BUCKET = process.env.GOOGLE_STORAGE_BUCKET_PRE_SCHEDULING || process.env.GOOGLE_STORAGE_BUCKET;

const storage = GCS_BUCKET ? new Storage() : null;
const bucket = (storage && GCS_BUCKET) ? storage.bucket(GCS_BUCKET) : null;

const normalizeStatus = (value?: string | null) => String(value || '').trim().toUpperCase();
const normalizeCpf = (value?: string | null) => String(value || '').replace(/\D/g, '');
const toDateOnly = (value?: string | null) => String(value || '').slice(0, 10);
const toBoolean = (value: unknown): boolean => ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());

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
          include: { documents: true },
        })
      : [];

    const flowByAppointmentId = new Map<string, any>();
    flows.forEach((flow: any) => {
      flowByAppointmentId.set(String(flow.appointmentId), flow);
    });

    const items = appointments
      .map((appointment: any) => {
        const flow = flowByAppointmentId.get(String(appointment.id));
        const itemStatus = String(flow?.status || 'PENDING').toUpperCase();
        const hasPreAuthorization = Boolean(flow?.preAuthorizedAt);
        const docsApproved = itemStatus === 'COMPLETED';
        const isResolved = hasPreAuthorization && docsApproved;
        return {
          id: String(appointment.id),
          appointmentId: String(appointment.id),
          patientId: appointment.patientId || null,
          patientName: appointment.patientName || flow?.patientName || '',
          patientCpf: normalizeCpf(appointment.patientCpf || flow?.patientCpf || ''),
          patientPhone: flow?.patientPhone || null,
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
          tokenAvailable: Boolean(flow?.publicToken),
          isResolved,
        };
      })
      .filter((item: any) => {
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

    const { flow } = ensured as any;

    const updatedFlow = await prisma.preSchedulingFlow.update({
      where: { id: flow.id },
      data: {
        status: String(flow?.status || '').toUpperCase() === 'DOCUMENTS_RECEIVED' ? 'COMPLETED' : 'PRE_AUTHORIZED',
        preAuthorizedAt: new Date(),
        guideNumber: guideNumber || flow.guideNumber || null,
        preAuthorizationNotes: notes || null,
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
      summary: 'Send (mock) whatsapp link for patient document upload',
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
    if (String(flow?.status || '').toUpperCase() === 'COMPLETED') {
      return reply.code(400).send({ error: 'Fluxo já concluído. Não é possível reenviar link.' });
    }

    const token = flow.publicToken || makePublicToken();
    const publicBase = String(process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
    const publicUrl = `${publicBase}/pre-agendamento/documentos/${token}`;
    const mockMessage = [
      `Olá ${flow.patientName || appointment.patientName || 'paciente'}!`,
      'Para adiantar seu atendimento, envie seus documentos neste link:',
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
        linkMockMessage: mockMessage,
      },
    });

    return reply.send({
      message: 'Link gerado e envio mockado com sucesso',
      item: updatedFlow,
      whatsappMock: {
        provider: 'mock',
        to: flow.patientPhone || null,
        message: mockMessage,
      },
      publicUrl,
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
      },
    });

    if (!flow) return reply.send({ items: [] });

    return reply.send({
      items: flow.documents.map((doc: any) => ({
        id: doc.id,
        documentType: doc.documentType,
        fileName: doc.fileName,
        mimeType: doc.mimeType,
        sizeBytes: doc.sizeBytes,
        uploadedAt: doc.uploadedAt,
      })),
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

    if (!bucket) {
      return reply.code(503).send({ error: 'Bucket GCS não configurado (GOOGLE_STORAGE_BUCKET_PRE_SCHEDULING ou GOOGLE_STORAGE_BUCKET)' });
    }

    const file = bucket.file(document.gcsObjectName);
    const [exists] = await file.exists();
    if (!exists) return reply.code(404).send({ error: 'Arquivo não encontrado no storage' });

    reply.header('Content-Type', document.mimeType || 'application/octet-stream');
    reply.header('Content-Disposition', `inline; filename="${document.fileName || 'documento'}"`);
    return reply.send(file.createReadStream());
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
      },
    });

    if (!flow) return reply.code(404).send({ error: 'Fluxo de pré-agendamento não encontrado' });
    if (!Array.isArray(flow.documents) || flow.documents.length === 0) {
      return reply.code(400).send({ error: 'Não há documentos para revisar' });
    }

    const nextStatus = action === 'APPROVE'
      ? (flow.preAuthorizedAt ? 'COMPLETED' : 'DOCUMENTS_RECEIVED')
      : 'WAITING_PATIENT_DOCUMENTS';
    const updated = await prisma.preSchedulingFlow.update({
      where: { id: flow.id },
      data: {
        status: nextStatus,
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
      },
    });

    if (!flow) return reply.code(404).send({ error: 'Link inválido ou expirado' });

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
      documentsCount: flow.documents.length,
      documents: flow.documents.map((doc: any) => ({
        id: doc.id,
        documentType: doc.documentType,
        fileName: doc.fileName,
        uploadedAt: doc.uploadedAt,
      })),
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

    if (!flow) return reply.code(404).send({ error: 'Link inválido ou expirado' });

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
        status: flow.status === 'PENDING' ? 'WAITING_PATIENT_DOCUMENTS' : flow.status,
      },
    });

    return reply.send({
      verified: true,
      trust: updated.patientVerifiedTrust,
      patientName: updated.patientVerifiedName,
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

    if (!flow) return reply.code(404).send({ error: 'Link inválido ou expirado' });

    if (!bucket) {
      return reply.code(503).send({ error: 'Bucket GCS não configurado (GOOGLE_STORAGE_BUCKET_PRE_SCHEDULING ou GOOGLE_STORAGE_BUCKET)' });
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
    const file = bucket.file(objectName);

    await file.save(buffer, {
      resumable: false,
      contentType: payload.mimeType || 'application/octet-stream',
      metadata: {
        metadata: {
          flowId: flow.id,
          documentType: payload.documentType,
          cpf: normalizedCpf,
        },
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

  app.post('/public/:token/finalize', {
    schema: {
      summary: 'Finalize patient document sending for pre-scheduling flow',
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
        documents: { select: { id: true } },
      },
    });

    if (!flow) return reply.code(404).send({ error: 'Link inválido ou expirado' });

    if (!flow.patientVerifiedAt) {
      return reply.code(400).send({ error: 'Validação de identidade pendente' });
    }

    if (!Array.isArray(flow.documents) || flow.documents.length === 0) {
      return reply.code(400).send({ error: 'Envie ao menos um documento antes de finalizar' });
    }

    const updated = await prisma.preSchedulingFlow.update({
      where: { id: flow.id },
      data: {
        status: 'DOCUMENTS_RECEIVED',
        patientSubmittedAt: new Date(),
      },
    });

    return reply.send({
      message: 'Envio finalizado com sucesso. Documentos prontos para revisão da clínica.',
      status: updated.status,
      patientSubmittedAt: updated.patientSubmittedAt,
    });
  });
}
