import { FastifyInstance } from 'fastify';
import prisma from '../../../lib/prisma';

export default async function branchSettingsRoutes(app: FastifyInstance) {
  // Get branch settings
  app.get('/branches/:branchId/settings', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Get branch settings',
      tags: ['Branch Settings'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          branchId: { type: 'string' },
        },
        required: ['branchId'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            branchId: { type: 'string' },
            requireFacialForReportDelivery: { type: 'boolean' },
            requireFacialForPatientRegistration: { type: 'boolean' },
            noShowToleranceMinutes: { type: 'number' },
          },
        },
        403: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { branchId } = request.params as { branchId: string };

    // Verify user has access to this branch
    const userId = (request.user as any).id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });

    if (!user?.sector?.branch?.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
    });

    if (!branch || branch.companyId !== user.sector.branch.companyId) {
      return reply.code(403).send({ error: 'Access denied to this branch' });
    }

    // Get or create settings
    let settings = await prisma.branchSettings.findUnique({
      where: { branchId },
    });

    if (!settings) {
      settings = await prisma.branchSettings.create({
        data: { branchId },
      });
    }

    return settings;
  });

  // Update branch settings
  app.put('/branches/:branchId/settings', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Update branch settings',
      tags: ['Branch Settings'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          branchId: { type: 'string' },
        },
        required: ['branchId'],
      },
      body: {
        type: 'object',
        properties: {
          requireFacialForReportDelivery: { type: 'boolean' },
          requireFacialForPatientRegistration: { type: 'boolean' },
          noShowToleranceMinutes: { type: 'number' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            branchId: { type: 'string' },
            requireFacialForReportDelivery: { type: 'boolean' },
            requireFacialForPatientRegistration: { type: 'boolean' },
            noShowToleranceMinutes: { type: 'number' },
          },
        },
        403: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const { requireFacialForReportDelivery, requireFacialForPatientRegistration, noShowToleranceMinutes } = request.body as {
      requireFacialForReportDelivery?: boolean;
      requireFacialForPatientRegistration?: boolean;
      noShowToleranceMinutes?: number;
    };

    // Verify user has access to this branch
    const userId = (request.user as any).id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });

    if (!user?.sector?.branch?.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
    });

    if (!branch || branch.companyId !== user.sector.branch.companyId) {
      return reply.code(403).send({ error: 'Access denied to this branch' });
    }

    // Update or create settings
    const settings = await prisma.branchSettings.upsert({
      where: { branchId },
      update: {
        ...(requireFacialForReportDelivery !== undefined ? { requireFacialForReportDelivery } : {}),
        ...(requireFacialForPatientRegistration !== undefined ? { requireFacialForPatientRegistration } : {}),
        ...(noShowToleranceMinutes !== undefined ? { noShowToleranceMinutes: Math.max(0, Math.floor(Number(noShowToleranceMinutes) || 0)) } : {}),
      },
      create: {
        branchId,
        ...(requireFacialForReportDelivery !== undefined ? { requireFacialForReportDelivery } : {}),
        ...(requireFacialForPatientRegistration !== undefined ? { requireFacialForPatientRegistration } : {}),
        ...(noShowToleranceMinutes !== undefined ? { noShowToleranceMinutes: Math.max(0, Math.floor(Number(noShowToleranceMinutes) || 0)) } : {}),
      },
    });

    return settings;
  });
}
