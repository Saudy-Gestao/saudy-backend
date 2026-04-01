import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';
import { isValidCpf, normalizeCpf } from '../../../lib/cpf';
import WhatsAppAutoSender from '../lib/whatsapp-auto-sender';

export default async function reportRoutes(app: FastifyInstance) {
  const getLoggedUser = async (request: any) => {
    const userId = (request.user as any)?.id;
    if (!userId) return { userId: null, userName: null, branchId: null, doctorName: null, doctorId: null };
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        sector: { include: { branch: true } },
        doctor: { select: { id: true, name: true } },
      },
    });
    return {
      userId: user?.id || null,
      userName: (user as any)?.name || null,
      branchId: user?.sector?.branch?.id || null,
      doctorName: user?.doctor?.name || null,
      doctorId: user?.doctor?.id || null,
    };
  };

  const getLoggedBranchId = async (request: any) => {
    const { branchId } = await getLoggedUser(request);
    return branchId;
  };

  const createAuditLog = async (params: {
    branchId: string;
    reportId?: string;
    action: string;
    performedByUserId?: string | null;
    performedByName?: string | null;
    details?: string;
  }) => {
    try {
      await prisma.reportAuditLog.create({ data: params });
    } catch {
      // audit log failures must not break the main operation
    }
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
      summary: 'List reports',
      tags: ['Reports'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          status: { type: 'string' },
          exam: { type: 'string' },
          worklistItemId: { type: 'string' },
          appointmentId: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const context = await getLoggedUser(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { search, status, exam, worklistItemId, appointmentId, limit = 50, offset = 0 } = request.query as any;

    const where: any = { isActive: true, branchId };
    if (status) where.status = status;
    if (exam) where.exam = exam;
    if (worklistItemId) where.worklistItemId = worklistItemId;
    if (appointmentId) where.appointmentId = appointmentId;
    if (search) {
      where.OR = [
        { patientName: { contains: search, mode: 'insensitive' } },
        { cpf: { contains: search, mode: 'insensitive' } },
        { requestingDoctor: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (context?.doctorName) {
      where.AND = where.AND || [];
      where.AND.push({
        OR: [
          { requestingDoctor: { equals: context.doctorName, mode: 'insensitive' } },
          { reportingDoctor: { equals: context.doctorName, mode: 'insensitive' } },
          { reviewingDoctor: { equals: context.doctorName, mode: 'insensitive' } },
          { responsibleDoctor: { equals: context.doctorName, mode: 'insensitive' } },
          { appointment: { doctorName: { equals: context.doctorName, mode: 'insensitive' } } },
        ],
      });
    }

    const [items, total] = await Promise.all([
      prisma.report.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
        include: {
          appointment: { select: { id: true, patientName: true, patientCpf: true, specialty: true, date: true, time: true, doctorName: true, convenio: true } },
          worklistItem: { select: { id: true, dicomStudyUid: true, dicomUrl: true, dicomReceivedAt: true } },
          addendums: { where: { isActive: true }, select: { id: true } },
        },
      }),
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
    const context = await getLoggedUser(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const item = await prisma.report.findFirst({
      where: {
        id,
        branchId,
        ...(context?.doctorName
          ? {
              OR: [
                { requestingDoctor: { equals: context.doctorName, mode: 'insensitive' } },
                { reportingDoctor: { equals: context.doctorName, mode: 'insensitive' } },
                { reviewingDoctor: { equals: context.doctorName, mode: 'insensitive' } },
                { responsibleDoctor: { equals: context.doctorName, mode: 'insensitive' } },
                { appointment: { doctorName: { equals: context.doctorName, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      include: {
        appointment: { select: { id: true, patientName: true, patientCpf: true, specialty: true, date: true, time: true, doctorName: true, status: true } },
        worklistItem: { select: { id: true, dicomStudyUid: true, dicomUrl: true, dicomReceivedAt: true, accessionNumber: true } },
        addendums: { where: { isActive: true }, orderBy: { updatedAt: 'desc' } },
      },
    });
    if (!item) return reply.code(404).send({ error: 'Report not found' });
    return item;
  });

  app.post('/', {
    schema: {
      summary: 'Create report',
      tags: ['Reports'],
      body: {
        type: 'object',
        properties: {
          worklistItemId: { type: 'string' },
          appointmentId: { type: 'string' },
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
          issuerSignedAt: { type: 'string' },
          reviewerSignedAt: { type: 'string' },
        },
      },
      response: {
        201: { type: 'object' },
        400: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const { branchId, userId, userName } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;

    // patientName is optional when worklistItemId or appointmentId is provided
    if (!data.worklistItemId && !data.appointmentId) {
      if (!data.patientName || !String(data.patientName).trim()) {
        return reply.code(400).send({ error: 'patientName is required when worklistItemId or appointmentId is not provided' });
      }
    }

    if (data.cpf) {
      const digits = normalizeCpf(data.cpf);
      if (!isValidCpf(digits)) {
        return reply.code(400).send({ error: 'cpf must be valid' });
      }
      data.cpf = digits; // normalize
    }

    if (data.birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(data.birthDate))) {
      return reply.code(400).send({ error: 'birthDate must be YYYY-MM-DD' });
    }

    try {
      const item = await prisma.report.create({ data: {
        branchId,
        worklistItemId: data.worklistItemId || null,
        appointmentId: data.appointmentId || null,
        patientName: data.patientName || null,
        cpf: data.cpf || null,
        birthDate: data.birthDate || null,
        requestingDoctor: data.requestingDoctor || null,
        reportingDoctor: data.reportingDoctor || null,
        reviewingDoctor: data.reviewingDoctor || null,
        description: data.description || null,
        conclusion: data.conclusion || null,
        notes: data.notes || null,
        status: data.status || 'rascunho',
        exam: data.exam || null,
        scheduledFor: data.scheduledFor || null,
        responsibleDoctor: data.responsibleDoctor || null,
        observation: data.observation || null,
        issuerSignedAt: data.issuerSignedAt || null,
        reviewerSignedAt: data.reviewerSignedAt || null,
      } });

      await createAuditLog({
        branchId,
        reportId: item.id,
        action: 'laudo_criado',
        performedByUserId: userId,
        performedByName: userName,
        details: JSON.stringify({
          status: item.status,
          paciente: item.patientName,
          exame: item.exam,
          medicoSolicitante: item.requestingDoctor,
          medicoLaudador: item.reportingDoctor,
        }),
      });

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
          worklistItemId: { type: 'string' },
          appointmentId: { type: 'string' },
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
          issuerSignedAt: { type: 'string' },
          reviewerSignedAt: { type: 'string' },
        },
      },
      response: {
        200: { type: 'object' },
        400: { type: 'object', additionalProperties: true },
        404: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const { branchId, userId, userName } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const data = request.body as any;

    try {
      const existing = await prisma.report.findFirst({ where: { id, branchId } });
      if (!existing) return reply.code(404).send({ error: 'Report not found' });

      // runtime validations for update
      if (data.patientName !== undefined && (!String(data.patientName).trim())) {
        return reply.code(400).send({ error: 'patientName cannot be empty' });
      }

      if (data.cpf) {
        const digits = normalizeCpf(data.cpf);
        if (!isValidCpf(digits)) {
          return reply.code(400).send({ error: 'cpf must be valid' });
        }
        data.cpf = digits;
      }

      if (data.birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(data.birthDate))) {
        return reply.code(400).send({ error: 'birthDate must be YYYY-MM-DD' });
      }

      const item = await prisma.report.update({ where: { id }, data: { ...data, branchId } });

      // Determine the most descriptive action label for meaningful status transitions
      let action = 'laudo_atualizado';
      if (data.status && data.status !== existing.status) {
        if (data.status === 'finalizado') {
          action = 'laudo_finalizado';
        } else if (existing.status === 'finalizado') {
          action = 'laudo_desfinalizado';
        } else {
          action = 'laudo_status_alterado';
        }
      } else if (data.issuerSignedAt && !existing.issuerSignedAt) {
        action = 'laudo_assinado_emissor';
      } else if (data.reviewerSignedAt && !existing.reviewerSignedAt) {
        action = 'laudo_assinado_revisor';
      } else if (data.description !== undefined) {
        action = 'laudo_conteudo_alterado';
      }

      const auditDetails: Record<string, any> = {};
      if (data.status && data.status !== existing.status) {
        auditDetails.statusAnterior = existing.status;
        auditDetails.statusNovo = data.status;
      }
      if (data.description !== undefined && data.description !== existing.description) {
        auditDetails.conteudoAnterior = existing.description || '';
        auditDetails.conteudoNovo = data.description || '';
      }
      if (data.issuerSignedAt !== undefined) {
        auditDetails.assinaturaEmissor = data.issuerSignedAt;
      }
      if (data.reviewerSignedAt !== undefined) {
        auditDetails.assinaturaRevisor = data.reviewerSignedAt;
      }
      auditDetails.medicoEmissor = item.issuerSignedAt ? (item.reportingDoctor || userName) : null;
      auditDetails.medicoRevisor = item.reviewerSignedAt ? (item.reviewingDoctor || null) : null;

      await createAuditLog({
        branchId,
        reportId: id,
        action,
        performedByUserId: userId,
        performedByName: userName,
        details: JSON.stringify(auditDetails),
      });

      if (existing.status !== 'finalizado' && item.status === 'finalizado' && item.appointmentId) {
        void (async () => {
          try {
            const alreadyNotified = await prisma.reportAuditLog.findFirst({
              where: {
                branchId,
                reportId: id,
                action: 'notificacao_exame_pronto_enviada',
              },
              select: { id: true },
            });

            if (alreadyNotified) return;

            const branch = await prisma.branch.findUnique({
              where: { id: branchId },
              select: { tradeName: true },
            });

            const result = await WhatsAppAutoSender.sendExamResultReadyMessage({
              branchId,
              appointmentId: item.appointmentId,
              patientName: item.patientName || null,
              examName: item.exam || null,
              clinicName: branch?.tradeName || null,
            });

            await createAuditLog({
              branchId,
              reportId: id,
              action: result.success ? 'notificacao_exame_pronto_enviada' : 'notificacao_exame_pronto_falhou',
              performedByUserId: userId,
              performedByName: userName,
              details: JSON.stringify({
                appointmentId: item.appointmentId,
                statusLaudo: item.status,
                error: result.error || null,
              }),
            });
          } catch (notifyError: any) {
            request.log.warn({ err: notifyError, reportId: id }, 'Failed to notify patient about ready report');
          }
        })();
      }

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
    const { branchId, userId, userName } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const existing = await prisma.report.findFirst({ where: { id, branchId } });
    if (!existing) return reply.code(404).send({ error: 'Report not found' });
    await prisma.report.delete({ where: { id } });
    await createAuditLog({
      branchId,
      reportId: id,
      action: 'laudo_excluido',
      performedByUserId: userId,
      performedByName: userName,
    });
    return { message: 'Deleted' };
  });
}
