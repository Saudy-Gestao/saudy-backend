import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function sectorRoutes(app: FastifyInstance) {
  const getLoggedContext = async (userId: string) => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });

    const branch = user?.sector?.branch;
    if (!branch?.companyId || !branch?.id) return null;
    return {
      companyId: branch.companyId,
      branchId: branch.id,
    };
  };

  // List all sectors
  app.get('/sectors', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'List all sectors',
      tags: ['Sectors'],
      security: [{ bearerAuth: [] }],
      response: { 200: { type: 'array', items: { $ref: 'Sector#' } }, 403: { type: 'object' } },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).id;
    const loggedContext = await getLoggedContext(userId);

    if (!loggedContext?.companyId || !loggedContext?.branchId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    const companyBranches = await prisma.branch.findMany({
      where: { companyId: loggedContext.companyId },
      select: { id: true },
    });

    const sectors = await prisma.sector.findMany({
      where: {
        branchId: {
          in: companyBranches.map((branch: { id: string }) => branch.id),
        },
      },
      include: { branch: true },
    });
    return sectors;
  });

  // Create a new sector
  app.post('/sectors', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Create sector',
      tags: ['Sectors'],
      security: [{ bearerAuth: [] }],
      body: { $ref: 'SectorCreate#' },
      response: { 200: { $ref: 'Sector#' }, 400: { type: 'object' }, 403: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { branchId, name, description } = request.body as {
      branchId: string;
      name: string;
      description: string;
    };

    const userId = (request.user as any).id;
    const loggedContext = await getLoggedContext(userId);

    if (!loggedContext?.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    const targetBranchId = String(branchId || '').trim();
    if (!targetBranchId) {
      return reply.code(400).send({ error: 'Filial é obrigatória' });
    }

    const branch = await prisma.branch.findFirst({
      where: {
        id: targetBranchId,
        companyId: loggedContext.companyId,
      },
      select: { id: true },
    });

    if (!branch) {
      return reply.code(403).send({ error: 'Filial inválida para sua empresa' });
    }

    const sector = await prisma.sector.create({
      data: { branchId: targetBranchId, name, description },
    });
    return sector;
  });

  // Get a sector by ID
  app.get('/sectors/:id', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Get sector by ID',
      tags: ['Sectors'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: { 200: { type: 'object' }, 403: { type: 'object' }, 404: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = (request.user as any).id;
    const loggedContext = await getLoggedContext(userId);

    if (!loggedContext?.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    const sector = await prisma.sector.findUnique({
      where: { id },
      include: { branch: true },
    });
    if (!sector) {
      return reply.code(404).send({ error: 'Sector not found' });
    }
    if (sector.branch?.companyId !== loggedContext.companyId) {
      return reply.code(403).send({ error: 'Setor fora da sua empresa' });
    }
    return sector;
  });

  // Update a sector by ID
  app.put('/sectors/:id', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Update sector',
      tags: ['Sectors'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object' },
      response: { 200: { type: 'object' }, 403: { type: 'object' }, 404: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { branchId, name, description } = request.body as {
      branchId?: string;
      name?: string;
      description?: string;
    };

    const userId = (request.user as any).id;
    const loggedContext = await getLoggedContext(userId);

    if (!loggedContext?.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    try {
      const current = await prisma.sector.findUnique({
        where: { id },
        include: { branch: true },
      });
      if (!current) {
        return reply.code(404).send({ error: 'Sector not found' });
      }
      if (current.branch?.companyId !== loggedContext.companyId) {
        return reply.code(403).send({ error: 'Setor fora da sua empresa' });
      }

      let resolvedBranchId = current.branchId;
      if (branchId) {
        const targetBranch = await prisma.branch.findFirst({
          where: {
            id: branchId,
            companyId: loggedContext.companyId,
          },
          select: { id: true },
        });

        if (!targetBranch) {
          return reply.code(403).send({ error: 'Você só pode mover setor para uma filial da sua empresa' });
        }

        resolvedBranchId = targetBranch.id;
      }

      const sector = await prisma.sector.update({
        where: { id },
        data: { branchId: resolvedBranchId, name, description },
      });
      return sector;
    } catch (error) {
      return reply.code(404).send({ error: 'Sector not found or invalid data' });
    }
  });

  // Delete a sector by ID
  app.delete('/sectors/:id', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Delete sector',
      tags: ['Sectors'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: { 200: { type: 'object' }, 403: { type: 'object' }, 404: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = (request.user as any).id;
    const loggedContext = await getLoggedContext(userId);

    if (!loggedContext?.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    try {
      const current = await prisma.sector.findUnique({
        where: { id },
        include: { branch: true },
      });
      if (!current) {
        return reply.code(404).send({ error: 'Sector not found' });
      }
      if (current.branch?.companyId !== loggedContext.companyId) {
        return reply.code(403).send({ error: 'Setor fora da sua empresa' });
      }

      await prisma.sector.delete({
        where: { id },
      });
      return { message: 'Sector deleted' };
    } catch (error) {
      return reply.code(404).send({ error: 'Sector not found' });
    }
  });
}
