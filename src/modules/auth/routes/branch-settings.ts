import { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import prisma from '../../../lib/prisma';

const buildSettingsResponse = async (branchId: string) => {
  let settings = await prisma.branchSettings.findUnique({ where: { branchId } });

  if (!settings) {
    settings = await prisma.branchSettings.create({
      data: { branchId },
    });
  }

  const publicCheckInAuditTrail = await prisma.branchPublicCheckInAuditLog.findMany({
    where: { branchId },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  return {
    ...settings,
    publicCheckInAuditTrail,
  };
};

export default async function branchSettingsRoutes(app: FastifyInstance) {
  app.get('/branches/:branchId/settings', {
    preHandler: async (request) => { await request.jwtVerify(); },
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
    },
  }, async (request, reply) => {
    const { branchId } = request.params as { branchId: string };

    const userId = (request.user as any).id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });

    if (!user?.sector?.branch?.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    const branch = await prisma.branch.findUnique({ where: { id: branchId } });

    if (!branch || branch.companyId !== user.sector.branch.companyId) {
      return reply.code(403).send({ error: 'Access denied to this branch' });
    }

    return buildSettingsResponse(branchId);
  });

  app.put('/branches/:branchId/settings', {
    preHandler: async (request) => { await request.jwtVerify(); },
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
          doctorCanScheduleExamFromConsultation: { type: 'boolean' },
          noShowToleranceMinutes: { type: 'number' },
          publicCheckInEnabled: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const {
      requireFacialForReportDelivery,
      requireFacialForPatientRegistration,
      doctorCanScheduleExamFromConsultation,
      noShowToleranceMinutes,
      publicCheckInEnabled,
    } = request.body as {
      requireFacialForReportDelivery?: boolean;
      requireFacialForPatientRegistration?: boolean;
      doctorCanScheduleExamFromConsultation?: boolean;
      noShowToleranceMinutes?: number;
      publicCheckInEnabled?: boolean;
    };

    const userId = (request.user as any).id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });

    if (!user?.sector?.branch?.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    const branch = await prisma.branch.findUnique({ where: { id: branchId } });

    if (!branch || branch.companyId !== user.sector.branch.companyId) {
      return reply.code(403).send({ error: 'Access denied to this branch' });
    }

    const current = await prisma.branchSettings.findUnique({ where: { branchId } });
    const currentEnabled = Boolean(current?.publicCheckInEnabled);
    const nextEnabled = publicCheckInEnabled !== undefined ? Boolean(publicCheckInEnabled) : currentEnabled;
    const now = new Date();
    const actorName = String(user.name || user.email || 'Usuário da clínica');

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.branchSettings.upsert({
        where: { branchId },
        update: {
          ...(requireFacialForReportDelivery !== undefined ? { requireFacialForReportDelivery } : {}),
          ...(requireFacialForPatientRegistration !== undefined ? { requireFacialForPatientRegistration } : {}),
          ...(doctorCanScheduleExamFromConsultation !== undefined ? { doctorCanScheduleExamFromConsultation } : {}),
          ...(noShowToleranceMinutes !== undefined ? { noShowToleranceMinutes: Math.max(0, Math.floor(Number(noShowToleranceMinutes) || 0)) } : {}),
          ...(publicCheckInEnabled !== undefined ? { publicCheckInEnabled: nextEnabled } : {}),
          ...(publicCheckInEnabled !== undefined && nextEnabled !== currentEnabled
            ? nextEnabled
              ? {
                  publicCheckInLastEnabledAt: now,
                  publicCheckInLastEnabledByUserId: user.id,
                  publicCheckInLastEnabledByName: actorName,
                }
              : {
                  publicCheckInLastDisabledAt: now,
                  publicCheckInLastDisabledByUserId: user.id,
                  publicCheckInLastDisabledByName: actorName,
                }
            : {}),
        },
        create: {
          branchId,
          ...(requireFacialForReportDelivery !== undefined ? { requireFacialForReportDelivery } : {}),
          ...(requireFacialForPatientRegistration !== undefined ? { requireFacialForPatientRegistration } : {}),
          ...(doctorCanScheduleExamFromConsultation !== undefined ? { doctorCanScheduleExamFromConsultation } : {}),
          ...(noShowToleranceMinutes !== undefined ? { noShowToleranceMinutes: Math.max(0, Math.floor(Number(noShowToleranceMinutes) || 0)) } : {}),
          publicCheckInEnabled: nextEnabled,
          ...(publicCheckInEnabled !== undefined
            ? nextEnabled
              ? {
                  publicCheckInLastEnabledAt: now,
                  publicCheckInLastEnabledByUserId: user.id,
                  publicCheckInLastEnabledByName: actorName,
                }
              : {
                  publicCheckInLastDisabledAt: now,
                  publicCheckInLastDisabledByUserId: user.id,
                  publicCheckInLastDisabledByName: actorName,
                }
            : {}),
        },
      });

      if (publicCheckInEnabled !== undefined && nextEnabled !== currentEnabled) {
        await tx.branchPublicCheckInAuditLog.create({
          data: {
            branchId,
            action: nextEnabled ? 'ENABLED' : 'DISABLED',
            performedByUserId: user.id,
            performedByName: actorName,
            createdAt: now,
          },
        });
      }
    });

    return buildSettingsResponse(branchId);
  });
}
