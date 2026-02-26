import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function branchRoutes(app: FastifyInstance) {
  // List all branches
  app.get('/branches', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'List all branches',
      tags: ['Branches'],
      security: [{ bearerAuth: [] }],
      response: { 200: { type: 'array', items: { $ref: 'Branch#' } }, 403: { type: 'object' } },
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
    
    // Return only branches from user's company
    const branches = await prisma.branch.findMany({
      where: { companyId: user.sector.branch.companyId },
      include: { company: true },
    });
    return branches;
  });

  // Create a new branch
  app.post('/branches', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Create branch',
      tags: ['Branches'],
      security: [{ bearerAuth: [] }],
      body: { $ref: 'BranchCreate#' },
      response: { 200: { $ref: 'Branch#' } },
    },
  }, async (request, reply) => {
    const { companyId, socialName, tradeName, address, phone } = request.body as {
      companyId: string;
      socialName: string;
      tradeName: string;
      address: string;
      phone: string;
    };
    
    // Verificar se já existe uma matriz para a empresa
    const existingMatriz = await prisma.branch.findFirst({
      where: { companyId, isMatriz: true },
    });
    
    const branch = await prisma.branch.create({
      data: { 
        companyId, 
        socialName, 
        tradeName, 
        address, 
        phone,
        isMatriz: !existingMatriz, // Se não houver matriz, esta será a matriz
      },
    });
    return branch;
  });

  // Get a branch by ID
  app.get('/branches/:id', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Get branch by ID',
      tags: ['Branches'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: { 200: { $ref: 'Branch#' }, 404: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const branch = await prisma.branch.findUnique({
      where: { id },
      include: { company: true },
    });
    if (!branch) {
      return reply.code(404).send({ error: 'Branch not found' });
    }
    return branch;
  });

  // Update a branch by ID
  app.put('/branches/:id', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Update branch',
      tags: ['Branches'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { $ref: 'BranchUpdate#' },
      response: { 200: { $ref: 'Branch#' }, 404: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { companyId, socialName, tradeName, address, phone } = request.body as {
      companyId?: string;
      socialName?: string;
      tradeName?: string;
      address?: string;
      phone?: string;
    };
    try {
      const branch = await prisma.branch.update({
        where: { id },
        data: { companyId, socialName, tradeName, address, phone },
      });
      return branch;
    } catch (error) {
      return reply.code(404).send({ error: 'Branch not found or invalid data' });
    }
  });

  // Delete a branch by ID
  app.delete('/branches/:id', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Delete branch',
      tags: ['Branches'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: { 200: { type: 'object' }, 404: { type: 'object' }, 400: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      // Verificar se é a matriz antes de deletar
      const branch = await prisma.branch.findUnique({ where: { id } });
      
      if (!branch) {
        return reply.code(404).send({ error: 'Branch not found' });
      }
      
      if (branch.isMatriz) {
        return reply.code(400).send({ error: 'Não é possível deletar a filial matriz' });
      }
      
      await prisma.branch.delete({
        where: { id },
      });
      return { message: 'Branch deleted' };
    } catch (error) {
      return reply.code(404).send({ error: 'Branch not found' });
    }
  });
}