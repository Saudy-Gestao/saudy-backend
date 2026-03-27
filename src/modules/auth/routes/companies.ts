import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma'; // Importe a instância do Prisma a partir de src/lib/prisma
import { Prisma } from '@prisma/client';
import {
  findCompanyByNormalizedCnpj,
  isValidNormalizedCnpj,
  normalizeCnpj,
} from '../lib/cnpj';

export default async function companyRoutes(app: FastifyInstance) {
  const getScopedCompanyId = async (requestUser: any) => {
    if (requestUser?.admHubOnly) {
      return { isAdmHubOnly: true as const, companyId: null };
    }

    const userId = requestUser?.id as string | undefined;
    if (!userId) return null;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });

    return {
      isAdmHubOnly: false as const,
      companyId: user?.sector?.branch?.companyId || null,
    };
  };

  // Example route to list companies
  app.get('/companies', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'List all companies',
      tags: ['Companies'],
      security: [{ bearerAuth: [] }],
      response: { 200: { type: 'array', items: { $ref: 'Company#' } }, 403: { type: 'object' } },
    },
  }, async (request, reply) => {
    const scope = await getScopedCompanyId(request.user);

    if (!scope) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    if (scope.isAdmHubOnly) {
      return prisma.company.findMany({
        orderBy: [
          { tradeName: 'asc' },
          { legalName: 'asc' },
        ],
      });
    }

    if (!scope.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    const companies = await prisma.company.findMany({
      where: { id: scope.companyId },
    });
    return companies;
  });

  // Create a new company
  app.post('/companies', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Create company',
      tags: ['Companies'],
      security: [{ bearerAuth: [] }],
      body: { $ref: 'CompanyCreate#' },
      response: {
        200: { $ref: 'Company#' },
        400: { type: 'object' },
        409: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const { cnpj, legalName, tradeName, address, phone, module_type, additionalBranchesAllowed } = request.body as {
      cnpj: string;
      legalName: string;
      tradeName: string;
      address: string;
      phone: string;
      module_type?: 'padrao' | 'tea' | 'apenas-tea';
      additionalBranchesAllowed?: number;
    };

    const normalizedCnpj = normalizeCnpj(cnpj);
    if (!isValidNormalizedCnpj(normalizedCnpj)) {
      return reply.code(400).send({ error: 'Invalid CNPJ' });
    }

    const existingCompany = await findCompanyByNormalizedCnpj(prisma, normalizedCnpj);
    if (existingCompany) {
      return reply.code(409).send({ error: 'CNPJ already registered' });
    }

    const company = await prisma.company.create({
      data: {
        cnpj: normalizedCnpj,
        legalName,
        tradeName,
        address,
        phone,
        module_type,
        additionalBranchesAllowed: Math.max(0, Number(additionalBranchesAllowed || 0)),
      },
    });
    return company;
  });

  // Get a company by ID
  app.get('/companies/:id', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Get company by ID',
      tags: ['Companies'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: {
        200: { $ref: 'Company#' },
        403: { type: 'object' },
        404: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const scope = await getScopedCompanyId(request.user);

    if (!scope) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    const company = await prisma.company.findUnique({
      where: { id },
    });
    if (!company) {
      return reply.code(404).send({ error: 'Company not found' });
    }

    if (!scope.isAdmHubOnly && scope.companyId !== company.id) {
      return reply.code(403).send({ error: 'Company outside of your scope' });
    }

    return company;
  });

  // Update a company by ID
  app.put('/companies/:id', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Update company',
      tags: ['Companies'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { $ref: 'CompanyCreate#' },
      response: {
        200: { $ref: 'Company#' },
        400: { type: 'object' },
        403: { type: 'object' },
        404: { type: 'object' },
        409: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const scope = await getScopedCompanyId(request.user);
    const { cnpj, legalName, tradeName, address, phone, module_type, additionalBranchesAllowed } = request.body as {
      cnpj?: string;
      legalName?: string;
      tradeName?: string;
      address?: string;
      phone?: string;
      module_type?: 'padrao' | 'tea' | 'apenas-tea';
      additionalBranchesAllowed?: number;
    };

    if (!scope) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    try {
      const existing = await prisma.company.findUnique({
        where: { id },
        select: { id: true },
      });

      if (!existing) {
        return reply.code(404).send({ error: 'Company not found' });
      }

      if (!scope.isAdmHubOnly && scope.companyId !== id) {
        return reply.code(403).send({ error: 'Company outside of your scope' });
      }

      let normalizedCnpj: string | undefined;
      if (typeof cnpj === 'string') {
        normalizedCnpj = normalizeCnpj(cnpj);
        if (!isValidNormalizedCnpj(normalizedCnpj)) {
          return reply.code(400).send({ error: 'Invalid CNPJ' });
        }

        const existingCompany = await findCompanyByNormalizedCnpj(prisma, normalizedCnpj, id);
        if (existingCompany) {
          return reply.code(409).send({ error: 'CNPJ already registered' });
        }
      }

      const company = await prisma.company.update({
        where: { id },
        data: {
          cnpj: normalizedCnpj,
          legalName,
          tradeName,
          address,
          phone,
          module_type,
          additionalBranchesAllowed: additionalBranchesAllowed === undefined
            ? undefined
            : Math.max(0, Number(additionalBranchesAllowed || 0)),
        },
      });
      return company;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return reply.code(409).send({ error: 'CNPJ already registered' });
      }

      return reply.code(404).send({ error: 'Company not found or invalid data' });
    }
  });

  // Delete a company by ID
  app.delete('/companies/:id', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Delete company',
      tags: ['Companies'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: {
        200: { type: 'object', example: { message: 'Company deleted' } },
        403: { type: 'object' },
        404: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const scope = await getScopedCompanyId(request.user);

    if (!scope?.isAdmHubOnly) {
      return reply.code(403).send({ error: 'Only ADM Hub can delete companies' });
    }

    try {
      await prisma.company.delete({
        where: { id },
      });
      return { message: 'Company deleted' };
    } catch (error) {
      return reply.code(404).send({ error: 'Company not found' });
    }
  });
}
