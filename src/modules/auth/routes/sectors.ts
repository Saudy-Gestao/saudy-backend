import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function sectorRoutes(app: FastifyInstance) {
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
    // Get logged user's company ID
    const userId = (request.user as any).id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });
    
    if (!user?.sector?.branch?.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }
    
    // Return only sectors from branches of user's company
    const sectors = await prisma.sector.findMany({
      where: { branch: { companyId: user.sector.branch.companyId } },
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
      response: { 200: { $ref: 'Sector#' } },
    },
  }, async (request, reply) => {
    const { branchId, name, description } = request.body as {
      branchId: string;
      name: string;
      description: string;
    };
    const sector = await prisma.sector.create({
      data: { branchId, name, description },
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
      response: { 200: { type: 'object' }, 404: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const sector = await prisma.sector.findUnique({
      where: { id },
      include: { branch: true },
    });
    if (!sector) {
      return reply.code(404).send({ error: 'Sector not found' });
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
      response: { 200: { type: 'object' }, 404: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { branchId, name, description } = request.body as {
      branchId?: string;
      name?: string;
      description?: string;
    };
    try {
      const sector = await prisma.sector.update({
        where: { id },
        data: { branchId, name, description },
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
      response: { 200: { type: 'object' }, 404: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await prisma.sector.delete({
        where: { id },
      });
      return { message: 'Sector deleted' };
    } catch (error) {
      return reply.code(404).send({ error: 'Sector not found' });
    }
  });
}