import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';
import { filterModulesForCompanyType, getRequestCompanyModuleType } from '../lib/module-type-access';

export default async function moduleRoutes(app: FastifyInstance) {
  // List all modules
  app.get('/modules', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'List all modules',
      tags: ['Modules'],
      security: [{ bearerAuth: [] }],
      response: {
        200: { type: 'array' },
        403: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const moduleType = await getRequestCompanyModuleType((request.user as any).id as string);
    if (!moduleType) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    const modules = await prisma.module.findMany({
      orderBy: [
        { category: 'asc' },
        { label: 'asc' },
      ],
    });
    return filterModulesForCompanyType(modules, moduleType);
  });

  // Get a module by ID
  app.get('/modules/:id', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Get module by ID',
      tags: ['Modules'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: { 200: { type: 'object' }, 404: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const module = await prisma.module.findUnique({
      where: { id },
    });
    if (!module) {
      return reply.code(404).send({ error: 'Module not found' });
    }
    return module;
  });
}
