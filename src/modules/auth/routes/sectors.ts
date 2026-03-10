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

    // Return only sectors from logged user's branch
    const sectors = await prisma.sector.findMany({
      where: { branchId: loggedContext.branchId },
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
      response: { 200: { $ref: 'Sector#' }, 403: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { branchId, name, description } = request.body as {
      branchId: string;
      name: string;
      description: string;
    };

    const userId = (request.user as any).id;
    const loggedContext = await getLoggedContext(userId);

    if (!loggedContext?.branchId) {
      return reply.code(403).send({ error: 'User not associated with a branch' });
    }

    if (branchId && branchId !== loggedContext.branchId) {
      return reply.code(403).send({ error: 'Você só pode cadastrar setor na sua filial' });
    }

    const sector = await prisma.sector.create({
      data: { branchId: loggedContext.branchId, name, description },
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

    if (!loggedContext?.branchId) {
      return reply.code(403).send({ error: 'User not associated with a branch' });
    }

    const sector = await prisma.sector.findUnique({
      where: { id },
      include: { branch: true },
    });
    if (!sector) {
      return reply.code(404).send({ error: 'Sector not found' });
    }
    if (sector.branchId !== loggedContext.branchId) {
      return reply.code(403).send({ error: 'Setor fora da sua filial' });
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

    if (!loggedContext?.branchId) {
      return reply.code(403).send({ error: 'User not associated with a branch' });
    }

    try {
      const current = await prisma.sector.findUnique({ where: { id } });
      if (!current) {
        return reply.code(404).send({ error: 'Sector not found' });
      }
      if (current.branchId !== loggedContext.branchId) {
        return reply.code(403).send({ error: 'Setor fora da sua filial' });
      }
      if (branchId && branchId !== loggedContext.branchId) {
        return reply.code(403).send({ error: 'Você só pode mover setor para sua filial' });
      }

      const sector = await prisma.sector.update({
        where: { id },
        data: { branchId: loggedContext.branchId, name, description },
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

    if (!loggedContext?.branchId) {
      return reply.code(403).send({ error: 'User not associated with a branch' });
    }

    try {
      const current = await prisma.sector.findUnique({ where: { id } });
      if (!current) {
        return reply.code(404).send({ error: 'Sector not found' });
      }
      if (current.branchId !== loggedContext.branchId) {
        return reply.code(403).send({ error: 'Setor fora da sua filial' });
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
