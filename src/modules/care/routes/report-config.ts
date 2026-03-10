import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

const getOrCreateConfig = async () => {
  const existing = await prisma.reportConfig.findFirst();
  if (existing) return existing;

  return prisma.reportConfig.create({
    data: {
      requiresReviewer: true,
    },
  });
};

export default async function reportConfigRoutes(app: FastifyInstance) {
  app.get('/', {
    schema: {
      summary: 'Get report configuration',
      tags: ['Report Config'],
    },
  }, async () => {
    return getOrCreateConfig();
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
    const data = request.body as any;

    if (typeof data?.requiresReviewer !== 'boolean') {
      return reply.code(400).send({ error: 'requiresReviewer must be boolean' });
    }

    const config = await getOrCreateConfig();
    return prisma.reportConfig.update({
      where: { id: config.id },
      data: {
        requiresReviewer: data.requiresReviewer,
      },
    });
  });
}
