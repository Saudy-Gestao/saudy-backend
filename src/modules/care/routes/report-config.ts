import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

const getOrCreateConfig = async (branchId: string) => {
  const existing = await prisma.reportConfig.findFirst({ where: { branchId } });
  if (existing) return existing;

  return prisma.reportConfig.create({
    data: {
      branchId,
      requiresReviewer: true,
    },
  });
};

export default async function reportConfigRoutes(app: FastifyInstance) {
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
  });

  app.get('/', {
    schema: {
      summary: 'Get report configuration',
      tags: ['Report Config'],
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });
    return getOrCreateConfig(branchId);
  });

  app.put('/', {
    schema: {
      summary: 'Update report configuration',
      tags: ['Report Config'],
      body: {
        type: 'object',
        properties: {
          requiresReviewer: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;

    if (typeof data?.requiresReviewer !== 'boolean') {
      return reply.code(400).send({ error: 'requiresReviewer must be boolean' });
    }

    const config = await getOrCreateConfig(branchId);
    return prisma.reportConfig.update({
      where: { id: config.id },
      data: {
        branchId,
        requiresReviewer: data.requiresReviewer,
      },
    });
  });
}
