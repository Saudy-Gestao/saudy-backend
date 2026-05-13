import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';
import { filterModulesForCompanyType, getRequestCompanyModuleType } from '../lib/module-type-access';

export default async function accessRoutes(app: FastifyInstance) {
  // List all accesses
  app.get('/accesses', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'List all accesses',
      tags: ['Accesses'],
      security: [{ bearerAuth: [] }],
      // Removido response schema para não filtrar dados
    },
  }, async (request, reply) => {
    const accesses = await prisma.access.findMany({
      include: {
        modules: true,
      },
    });
    return accesses;
  });

  // Create a new access
  app.post('/accesses', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Create access',
      tags: ['Accesses'],
      security: [{ bearerAuth: [] }],
      body: { $ref: 'AccessCreate#' },
      response: { 
        200: { $ref: 'Access#' },
        400: { type: 'object', properties: { error: { type: 'string' }  } },
        403: { type: 'object', properties: { error: { type: 'string' }  } }
      },
    },
  }, async (request, reply) => {
    const { description, moduleIds } = request.body as {
      description: string;
      moduleIds?: string[];
    };
    const moduleType = await getRequestCompanyModuleType((request.user as any).id as string);

    // Validation: At least one module is required
    if (!moduleIds || moduleIds.length === 0) {
      reply.code(400).send({ error: 'At least one module is required' });
      return;
    }

    if (!moduleType) {
      reply.code(403).send({ error: 'User not associated with a company' });
      return;
    }

    const requestedModules = await prisma.module.findMany({
      where: { id: { in: moduleIds } },
    });
    const allowedModuleIds = new Set(filterModulesForCompanyType(requestedModules, moduleType).map((module: any) => module.id));
    const hasInvalidModule = moduleIds.some((id) => !allowedModuleIds.has(id));

    if (hasInvalidModule) {
      reply.code(400).send({ error: 'One or more modules are not allowed for this company type' });
      return;
    }

    const access = await prisma.access.create({
      data: {
        description,
        modules: {
          connect: moduleIds.map((id) => ({ id })),
        },
      },
      include: {
        modules: true,
      },
    });
    return access;
  });

  // Get an access by ID
  app.get('/accesses/:id', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Get access by ID',
      tags: ['Accesses'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: { 200: { type: 'object' }, 404: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const access = await prisma.access.findUnique({
      where: { id },
      include: {
        modules: true,
      },
    });
    if (!access) {
      reply.code(404).send({ error: 'Access not found' });
      return;
    }
    return access;
  });

  // Update an access by ID
  app.put('/accesses/:id', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Update access',
      tags: ['Accesses'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object' },
      response: {
        200: { type: 'object' },
        400: { type: 'object', properties: { error: { type: 'string' } } },
        403: { type: 'object' },
        404: { type: 'object' }
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { description, moduleIds } = request.body as {
      description?: string;
      moduleIds?: string[];
    };

    const existingAccess = await prisma.access.findUnique({ where: { id } });
    if (existingAccess?.isTemplate) {
      reply.code(403).send({ error: 'Default access templates cannot be modified' });
      return;
    }

    const moduleType = await getRequestCompanyModuleType((request.user as any).id as string);

    // Validation: If moduleIds is provided, must not be empty
    if (moduleIds !== undefined && moduleIds.length === 0) {
      reply.code(400).send({ error: 'At least one module is required' });
      return;
    }

    if (!moduleType) {
      reply.code(403).send({ error: 'User not associated with a company' });
      return;
    }

    try {
      const updateData: any = {};
      
      if (description !== undefined) {
        updateData.description = description;
      }

      if (moduleIds !== undefined) {
        const requestedModules = await prisma.module.findMany({
          where: { id: { in: moduleIds } },
        });
        const allowedModuleIds = new Set(filterModulesForCompanyType(requestedModules, moduleType).map((module: any) => module.id));
        const hasInvalidModule = moduleIds.some((candidateId) => !allowedModuleIds.has(candidateId));

        if (hasInvalidModule) {
          reply.code(400).send({ error: 'One or more modules are not allowed for this company type' });
          return;
        }

        // First disconnect all modules, then connect the new ones
        updateData.modules = {
          set: moduleIds.map((id) => ({ id })),
        };
      }

      const access = await prisma.access.update({
        where: { id },
        data: updateData,
        include: {
          modules: true,
        },
      });
      return access;
    } catch (error) {
      reply.code(404).send({ error: 'Access not found or invalid data' });
      return;
    }
  });

  // Delete an access by ID
  app.delete('/accesses/:id', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Delete access',
      tags: ['Accesses'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: { 200: { type: 'object' }, 403: { type: 'object' }, 404: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const existingAccess = await prisma.access.findUnique({ where: { id } });
    if (existingAccess?.isTemplate) {
      reply.code(403).send({ error: 'Default access templates cannot be deleted' });
      return;
    }

    try {
      await prisma.access.delete({
        where: { id },
      });
      return { message: 'Access deleted' };
    } catch (error) {
      reply.code(404).send({ error: 'Access not found' });
      return;
    }
  });
}
