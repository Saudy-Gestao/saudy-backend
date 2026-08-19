import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';
import { createDefaultSectorsForBranch } from '../lib/default-sectors';
import { normalizeCnpj, isValidNormalizedCnpj } from '../lib/cnpj';

type BranchCnpjEntry = { cnpj: string; label?: string; isPrimary: boolean };

function normalizeCnpjEntries(raw: unknown): BranchCnpjEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const entries: BranchCnpjEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const cnpj = normalizeCnpj(String((item as any).cnpj || ''));
    if (!cnpj) continue;
    if (!isValidNormalizedCnpj(cnpj)) {
      throw new Error(`CNPJ inválido: ${cnpj}`);
    }
    if (seen.has(cnpj)) continue;
    seen.add(cnpj);
    const label = String((item as any).label || '').trim();
    entries.push({ cnpj, label: label || undefined, isPrimary: Boolean((item as any).isPrimary) });
  }

  const primaryCount = entries.filter((e) => e.isPrimary).length;
  if (primaryCount === 0 && entries.length > 0) {
    entries[0].isPrimary = true;
  } else if (primaryCount > 1) {
    let markedFirst = false;
    for (const entry of entries) {
      if (!entry.isPrimary) continue;
      if (markedFirst) entry.isPrimary = false;
      else markedFirst = true;
    }
  }

  return entries;
}

function mapBranchResponse(branch: any) {
  let cnpjs: BranchCnpjEntry[] = [];
  try {
    cnpjs = branch.cnpjs ? JSON.parse(branch.cnpjs) : [];
  } catch {
    cnpjs = [];
  }
  return { ...branch, cnpjs };
}

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
        cnpjs: true,
      },
    });

    if (branches.length === 0) {
      return branches.map(mapBranchResponse);
    }

    const hasMatriz = branches.some((branch: any) => branch.isMatriz);
    if (hasMatriz) {
      return branches.map(mapBranchResponse);
    }

    const firstBranchId = branches[0].id;
    await prisma.branch.update({
      where: { id: firstBranchId },
      data: { isMatriz: true },
    });

    return branches.map((branch: any) => mapBranchResponse(
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
      response: { 200: { $ref: 'Branch#' }, 400: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { companyId, tradeName, address, phone, isMatriz, type, cnpjs } = request.body as {
      companyId: string;
      tradeName: string;
      address: string;
      phone: string;
      isMatriz?: boolean;
      type?: 'Filial' | 'Matriz';
      cnpjs?: unknown;
    };

    let normalizedCnpjs: BranchCnpjEntry[];
    try {
      normalizedCnpjs = normalizeCnpjEntries(cnpjs);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message || 'CNPJ inválido' });
    }

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

      const created = await tx.branch.create({
        data: {
          companyId,
          tradeName,
          address,
          phone,
          isMatriz: shouldBeMatriz,
          cnpjs: JSON.stringify(normalizedCnpjs),
        },
        select: {
          id: true,
          companyId: true,
          tradeName: true,
          address: true,
          phone: true,
          isMatriz: true,
          cnpjs: true,
        },
      });

      await createDefaultSectorsForBranch(created.id, tx);

      return created;
    });
    return mapBranchResponse(branch);
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
        cnpjs: true,
      },
    });
    if (!branch) {
      return reply.code(404).send({ error: 'Branch not found' });
    }
    return mapBranchResponse(branch);
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
    const { companyId, tradeName, address, phone, isMatriz, type, cnpjs } = request.body as {
      companyId?: string;
      tradeName?: string;
      address?: string;
      phone?: string;
      isMatriz?: boolean;
      type?: 'Filial' | 'Matriz';
      cnpjs?: unknown;
    };

    let normalizedCnpjs: BranchCnpjEntry[] | undefined;
    if (cnpjs !== undefined) {
      try {
        normalizedCnpjs = normalizeCnpjEntries(cnpjs);
      } catch (err: any) {
        return reply.code(400).send({ error: err.message || 'CNPJ inválido' });
      }
    }

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
            ...(normalizedCnpjs !== undefined ? { cnpjs: JSON.stringify(normalizedCnpjs) } : {}),
          },
          select: {
            id: true,
            companyId: true,
            tradeName: true,
            address: true,
            phone: true,
            isMatriz: true,
            cnpjs: true,
          },
        });
      });
      return mapBranchResponse(branch);
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

  // Create default sectors for an existing branch
  app.post('/branches/:id/default-sectors', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Create default sectors for a branch',
      tags: ['Branches'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: {
        200: { type: 'object', properties: { message: { type: 'string' } } },
        404: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const branch = await prisma.branch.findUnique({ where: { id } });
    if (!branch) {
      return reply.code(404).send({ error: 'Branch not found' });
    }

    await prisma.$transaction(async (tx: any) => {
      await createDefaultSectorsForBranch(id, tx);
    });

    return { message: 'Setores padrão criados com sucesso' };
  });
}