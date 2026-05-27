import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function reportAddendumRoutes(app: FastifyInstance) {
  const getLoggedUser = async (request: any) => {
    const userId = (request.user as any)?.id;
    if (!userId) return { userId: null, userName: null, branchId: null };
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });
    return {
      userId: user?.id || null,
      userName: (user as any)?.name || null,
      doctorId: (user as any)?.doctorId || null,
      branchId: user?.sector?.branch?.id || null,
    };
  };

  const getLoggedBranchId = async (request: any) => {
    const { branchId } = await getLoggedUser(request);
    return branchId;
  };

  const createAuditLog = async (params: {
    branchId: string;
    reportId?: string | null;
    addendumId?: string | null;
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
      summary: 'List report addendums',
      tags: ['Report Addendums'],
      querystring: {
        type: 'object',
        properties: {
          worklistItemId: { type: 'string' },
          reportId: { type: 'string' },
          status: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { worklistItemId, reportId, status, limit = 50, offset = 0 } = request.query as any;

    if (!worklistItemId && !reportId) {
      return reply.code(400).send({ error: 'worklistItemId or reportId is required' });
    }

    const where: any = {
      branchId,
      isActive: true,
    };

    if (worklistItemId) where.worklistItemId = worklistItemId;
    if (reportId) where.reportId = reportId;
    if (status) where.status = status;

    const [items, total] = await Promise.all([
      prisma.reportAddendum.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.reportAddendum.count({ where }),
    ]);

    return { items, total };
  });

  app.post('/', {
    schema: {
      summary: 'Create report addendum draft',
      tags: ['Report Addendums'],
      body: {
        type: 'object',
        required: [],
        properties: {
          worklistItemId: { type: 'string', minLength: 1 },
          reportId: { type: 'string', minLength: 1 },
          content: { type: 'string' },
          status: { type: 'string' },
          issuerSignedAt: { type: 'string' },
          issuerDoctorId: { type: 'string' },
          issuerDoctor: { type: 'string' },
          reviewerSignedAt: { type: 'string' },
          savedAt: { type: 'string' },
          finalizedAt: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { branchId, userId, userName } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;

    if (!data.worklistItemId && !data.reportId) {
      return reply.code(400).send({ error: 'worklistItemId or reportId is required' });
    }

    try {
      if (data.worklistItemId) {
        const worklistItem = await prisma.reportWorklistItem.findFirst({ where: { id: data.worklistItemId, branchId } });
        if (!worklistItem) {
          return reply.code(404).send({ error: 'Report worklist item not found' });
        }
      }

      let resolvedReportWorklistItemId: string | null = null;
      if (data.reportId) {
        const report = await prisma.report.findFirst({
          where: { id: data.reportId, branchId },
          select: { id: true, worklistItemId: true },
        });
        if (!report) {
          return reply.code(404).send({ error: 'Report (laudo) not found' });
        }
        resolvedReportWorklistItemId = report.worklistItemId || null;
      }

      const resolvedWorklistItemId = data.worklistItemId || resolvedReportWorklistItemId || null;

      const item = await prisma.reportAddendum.create({
        data: {
          branchId,
          worklistItemId: resolvedWorklistItemId,
          reportId: data.reportId || null,
          content: data.content || '',
          status: data.status || 'draft',
          issuerSignedAt: null,
          issuerDoctorId: data.issuerDoctorId || null,
          issuerDoctor: data.issuerDoctor || null,
          reviewerSignedAt: null,
          savedAt: new Date(),
          finalizedAt: null,
        },
      });

      await createAuditLog({
        branchId,
        reportId: data.reportId || null,
        addendumId: item.id,
        action: 'adendo_criado',
        performedByUserId: userId,
        performedByName: userName,
        details: JSON.stringify({ status: item.status }),
      });

      return reply.code(201).send(item);
    } catch (err: any) {
      request.log.error({ err }, 'Failed to create report addendum');
      return reply.code(400).send({ error: 'Failed to create report addendum', details: err.message });
    }
  });

  app.put('/:id', {
    schema: {
      summary: 'Update report addendum',
      tags: ['Report Addendums'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object' },
    },
  }, async (request, reply) => {
    const { branchId, userId, userName, doctorId } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const data = request.body as any;

    try {
      const existing = await prisma.reportAddendum.findFirst({ where: { id, branchId } });
      if (!existing) return reply.code(404).send({ error: 'Report addendum not found' });

      const updateData: any = { ...data, branchId };
      delete updateData.issuerSignedAt;
      delete updateData.reviewerSignedAt;
      delete updateData.savedAt;
      delete updateData.finalizedAt;

      // If addendum is linked to a report and worklist item was omitted, inherit from report.
      if ((updateData.worklistItemId === undefined || updateData.worklistItemId === null || updateData.worklistItemId === '') && existing.reportId) {
        const report = await prisma.report.findFirst({
          where: { id: existing.reportId, branchId },
          select: { worklistItemId: true },
        });
        updateData.worklistItemId = report?.worklistItemId || null;
      }

      if (data.status === 'finalizado') {
        const effectiveIssuerSignedAt = existing.issuerSignedAt ?? null;
        if (!effectiveIssuerSignedAt) {
          return reply.code(400).send({ error: 'issuerSignedAt is required to finalize addendum' });
        }
        updateData.finalizedAt = new Date();
      } else if (data.status && data.status !== existing.status && data.status !== 'finalizado') {
        updateData.finalizedAt = null;
      }

      const isIssuerSigningNow = Boolean(data.issuerSignedAt) && !existing.issuerSignedAt;
      if (isIssuerSigningNow) {
        if (!doctorId) return reply.code(400).send({ error: 'User is not associated with a doctor' });
        updateData.issuerDoctorId = doctorId;
        updateData.issuerDoctor = userName || null;
        updateData.issuerSignedAt = new Date();
      }

      if (data.content !== undefined || data.status === 'draft') {
        updateData.savedAt = new Date();
      }

      const item = await prisma.reportAddendum.update({ where: { id }, data: updateData });

      let action = 'adendo_atualizado';
      if (data.status && data.status !== existing.status) {
        if (data.status === 'finalizado') {
          action = 'adendo_finalizado';
        } else {
          action = 'adendo_status_alterado';
        }
      } else if (data.issuerSignedAt && !existing.issuerSignedAt) {
        action = 'adendo_assinado_emissor';
      } else if (data.reviewerSignedAt && !existing.reviewerSignedAt) {
        action = 'adendo_assinado_revisor';
      } else if (data.content !== undefined) {
        action = 'adendo_conteudo_alterado';
      }

      const auditDetails: Record<string, any> = {};
      if (data.status && data.status !== existing.status) {
        auditDetails.statusAnterior = existing.status;
        auditDetails.statusNovo = data.status;
      }
      if (data.content !== undefined && data.content !== existing.content) {
        auditDetails.conteudoAnterior = existing.content || '';
        auditDetails.conteudoNovo = data.content || '';
      }
      if (data.issuerSignedAt !== undefined) {
        auditDetails.assinaturaEmissor = data.issuerSignedAt;
      }
      if (data.reviewerSignedAt !== undefined) {
        auditDetails.assinaturaRevisor = data.reviewerSignedAt;
      }

      await createAuditLog({
        branchId,
        reportId: existing.reportId || null,
        addendumId: id,
        action,
        performedByUserId: userId,
        performedByName: userName,
        details: JSON.stringify(auditDetails),
      });

      return item;
    } catch (err: any) {
      request.log.error({ err }, 'Failed to update report addendum');
      return reply.code(400).send({ error: 'Failed to update report addendum', details: err.message });
    }
  });

  app.delete('/:id', {
    schema: {
      summary: 'Delete report addendum',
      tags: ['Report Addendums'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { branchId, userId, userName } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const existing = await prisma.reportAddendum.findFirst({ where: { id, branchId } });
    if (!existing) return reply.code(404).send({ error: 'Report addendum not found' });
    await prisma.reportAddendum.delete({ where: { id } });
    await createAuditLog({
      branchId,
      reportId: existing.reportId || null,
      addendumId: id,
      action: 'adendo_removido',
      performedByUserId: userId,
      performedByName: userName,
      details: JSON.stringify({
        statusAnterior: existing.status,
        conteudoAnterior: existing.content || '',
        assinaturaEmissor: existing.issuerSignedAt,
        assinaturaRevisor: existing.reviewerSignedAt,
        finalizado: existing.finalizedAt,
      }),
    });
    return { message: 'Deleted' };
  });
}
