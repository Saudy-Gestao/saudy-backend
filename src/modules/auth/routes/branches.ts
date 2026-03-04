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
    const companyId = user.sector.branch.companyId;

    const branches = await prisma.branch.findMany({
      where: { companyId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        companyId: true,
        tradeName: true,
        address: true,
        phone: true,
        isMatriz: true,
      },
    });

    if (branches.length === 0) {
      return branches;
    }

    const hasMatriz = branches.some((branch) => branch.isMatriz);
    if (hasMatriz) {
      return branches;
    }

    const firstBranchId = branches[0].id;
    await prisma.branch.update({
      where: { id: firstBranchId },
      data: { isMatriz: true },
    });

    return branches.map((branch) => (
      branch.id === firstBranchId
        ? { ...branch, isMatriz: true }
        : branch
    ));
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
    const { companyId, tradeName, address, phone, isMatriz, type } = request.body as {
      companyId: string;
      tradeName: string;
      address: string;
      phone: string;
      isMatriz?: boolean;
      type?: 'Filial' | 'Matriz';
    };
    
    // Verificar se já existe uma matriz para a empresa
    const existingMatriz = await prisma.branch.findFirst({
      where: { companyId, isMatriz: true },
    });
    
    const resolvedIsMatriz = typeof isMatriz === 'boolean' ? isMatriz : type === 'Matriz';
    const shouldBeMatriz = Boolean(resolvedIsMatriz) || !existingMatriz;

    const branch = await prisma.$transaction(async (tx: any) => {
      if (shouldBeMatriz) {
        await tx.branch.updateMany({
          where: { companyId, isMatriz: true },
          data: { isMatriz: false },
        });
      }

      return tx.branch.create({
        data: {
          companyId,
          tradeName,
          address,
          phone,
          isMatriz: shouldBeMatriz,
        },
        select: {
          id: true,
          companyId: true,
          tradeName: true,
          address: true,
          phone: true,
          isMatriz: true,
        },
      });
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
      select: {
        id: true,
        companyId: true,
        tradeName: true,
        address: true,
        phone: true,
        isMatriz: true,
      },
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
      response: { 200: { $ref: 'Branch#' }, 400: { type: 'object' }, 404: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { companyId, tradeName, address, phone, isMatriz, type } = request.body as {
      companyId?: string;
      tradeName?: string;
      address?: string;
      phone?: string;
      isMatriz?: boolean;
      type?: 'Filial' | 'Matriz';
    };
    try {
      const currentBranch = await prisma.branch.findUnique({ where: { id } });
      if (!currentBranch) {
        return reply.code(404).send({ error: 'Branch not found or invalid data' });
      }

      const targetCompanyId = companyId || currentBranch.companyId;
      const resolvedIsMatriz = typeof isMatriz === 'boolean' ? isMatriz : (type === 'Matriz' ? true : type === 'Filial' ? false : undefined);
      const wantsMatriz = resolvedIsMatriz === true;
      const wantsFilial = resolvedIsMatriz === false;

      if (wantsFilial && currentBranch.isMatriz) {
        const anotherMatriz = await prisma.branch.findFirst({
          where: {
            companyId: targetCompanyId,
            isMatriz: true,
            NOT: { id },
          },
        });

        if (!anotherMatriz) {
          return reply.code(400).send({ error: 'A empresa deve ter ao menos uma matriz' });
        }
      }

      const branch = await prisma.$transaction(async (tx: any) => {
        if (wantsMatriz) {
          await tx.branch.updateMany({
            where: { companyId: targetCompanyId, isMatriz: true, NOT: { id } },
            data: { isMatriz: false },
          });
        }

        return tx.branch.update({
          where: { id },
          data: {
            companyId,
            tradeName,
            address,
            phone,
            ...(resolvedIsMatriz !== undefined ? { isMatriz: resolvedIsMatriz } : {}),
          },
          select: {
            id: true,
            companyId: true,
            tradeName: true,
            address: true,
            phone: true,
            isMatriz: true,
          },
        });
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