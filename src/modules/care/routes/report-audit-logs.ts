import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function reportAuditLogRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  const getLoggedBranchId = async (request: any) => {
    const userId = (request.user as any)?.id;
    if (!userId) return null;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });
    return user?.sector?.branch?.id || null;
  };

  app.get('/', {
    schema: {
      summary: 'List report audit logs',
      tags: ['Report Audit Logs'],
      querystring: {
        type: 'object',
        properties: {
          reportId: { type: 'string' },
          addendumId: { type: 'string' },
          limit: { type: 'number', default: 100 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { reportId, addendumId, limit = 100, offset = 0 } = request.query as any;

    if (!reportId && !addendumId) {
      return reply.code(400).send({ error: 'reportId or addendumId is required' });
    }

    const where: any = { branchId };
    if (reportId) where.reportId = reportId;
    if (addendumId) where.addendumId = addendumId;

    const [items, total] = await Promise.all([
      prisma.reportAuditLog.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.reportAuditLog.count({ where }),
    ]);

    return { items, total };
  });
}
