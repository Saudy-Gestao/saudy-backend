import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma'; // Importe a instância do Prisma a partir de src/lib/prisma

export default async function companyRoutes(app: FastifyInstance) {
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
    // Get logged user's company ID
    const userId = (request.user as any).id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });
    
    if (!user?.sector?.branch?.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }
    
    // Return only user's company
    const companies = await prisma.company.findMany({
      where: { id: user.sector.branch.companyId },
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
      response: { 200: { $ref: 'Company#' } },
    },
  }, async (request, reply) => {
    const { cnpj, legalName, tradeName, address, phone } = request.body as {
      cnpj: string;
      legalName: string;
      tradeName: string;
      address: string;
      phone: string;
    };
    const company = await prisma.company.create({
      data: { cnpj, legalName, tradeName, address, phone },
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
      response: { 200: { $ref: 'Company#' }, 404: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const company = await prisma.company.findUnique({
      where: { id },
    });
    if (!company) {
      return reply.code(404).send({ error: 'Company not found' });
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
      response: { 200: { $ref: 'Company#' }, 404: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { cnpj, legalName, tradeName, address, phone } = request.body as {
      cnpj?: string;
      legalName?: string;
      tradeName?: string;
      address?: string;
      phone?: string;
    };
    try {
      const company = await prisma.company.update({
        where: { id },
        data: { cnpj, legalName, tradeName, address, phone },
      });
      return company;
    } catch (error) {
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
      response: { 200: { type: 'object', example: { message: 'Company deleted' } }, 404: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
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