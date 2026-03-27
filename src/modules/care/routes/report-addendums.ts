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

      if (data.reportId) {
        const report = await prisma.report.findFirst({ where: { id: data.reportId, branchId } });
        if (!report) {
          return reply.code(404).send({ error: 'Report (laudo) not found' });
        }
      }

      const item = await prisma.reportAddendum.create({
        data: {
          branchId,
          worklistItemId: data.worklistItemId || null,
          reportId: data.reportId || null,
          content: data.content || '',
          status: data.status || 'draft',
          issuerSignedAt: data.issuerSignedAt || null,
          reviewerSignedAt: data.reviewerSignedAt || null,
          savedAt: data.savedAt || null,
          finalizedAt: data.finalizedAt || null,
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
    const { branchId, userId, userName } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const data = request.body as any;

    try {
      const existing = await prisma.reportAddendum.findFirst({ where: { id, branchId } });
      if (!existing) return reply.code(404).send({ error: 'Report addendum not found' });

      const item = await prisma.reportAddendum.update({ where: { id }, data: { ...data, branchId } });

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
