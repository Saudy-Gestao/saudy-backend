import { FastifyInstance } from 'fastify';
import { LeadStatus, Prisma } from '@prisma/client';
import prisma from '../lib/prisma';

const leadStatusValues = ['NEW', 'CONTACTED', 'QUALIFIED', 'LOST'] as const;

function normalizeOptionalString(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeRequiredString(value: unknown) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeEmail(value: unknown) {
  return normalizeRequiredString(value).toLowerCase();
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeStatus(value: unknown): LeadStatus | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return leadStatusValues.includes(normalized as LeadStatus) ? (normalized as LeadStatus) : null;
}

export default async function leadRoutes(app: FastifyInstance) {
  app.get('/', {
    preHandler: async (request) => { await request.jwtVerify(); },
    schema: {
      summary: 'List captured leads',
      tags: ['Leads'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          status: { type: 'string', enum: ['ALL', ...leadStatusValues] },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { $ref: 'Lead#' } },
            total: { type: 'number' },
            limit: { type: 'number' },
            offset: { type: 'number' },
          },
        },
      },
    },
  }, async (request) => {
    const { search, status, limit = 50, offset = 0 } = request.query as {
      search?: string;
      status?: LeadStatus | 'ALL';
      limit?: number;
      offset?: number;
    };

    const where: Prisma.LeadWhereInput = {};
    const normalizedSearch = normalizeOptionalString(search);

    if (normalizedSearch) {
      where.OR = [
        { name: { contains: normalizedSearch, mode: 'insensitive' } },
        { email: { contains: normalizedSearch, mode: 'insensitive' } },
        { phone: { contains: normalizedSearch, mode: 'insensitive' } },
        { companyName: { contains: normalizedSearch, mode: 'insensitive' } },
        { message: { contains: normalizedSearch, mode: 'insensitive' } },
      ];
    }

    if (status && status !== 'ALL') {
      where.status = status;
    }

    const take = Number.isFinite(Number(limit)) ? Number(limit) : 50;
    const skip = Number.isFinite(Number(offset)) ? Number(offset) : 0;

    const [items, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        take,
        skip,
        orderBy: [
          { createdAt: 'desc' },
        ],
      }),
      prisma.lead.count({ where }),
    ]);

    return { items, total, limit: take, offset: skip };
  });

  app.post('/', {
    schema: {
      summary: 'Capture a new lead',
      tags: ['Leads'],
      body: { $ref: 'LeadCreate#' },
      response: {
        201: { $ref: 'Lead#' },
        400: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      name?: string;
      email?: string;
      phone?: string;
      message?: string;
      source?: string;
      companyName?: string;
    };

    const name = normalizeRequiredString(body?.name);
    const email = normalizeEmail(body?.email);
    const phone = normalizeOptionalString(body?.phone);
    const message = normalizeOptionalString(body?.message);
    const source = normalizeOptionalString(body?.source) || 'Landing page';
    const companyName = normalizeOptionalString(body?.companyName);

    const fieldErrors: Record<string, string> = {};
    if (!name) fieldErrors.name = 'Nome é obrigatório';
    if (!email) fieldErrors.email = 'E-mail é obrigatório';
    else if (!isValidEmail(email)) fieldErrors.email = 'E-mail inválido';
    if (!phone) fieldErrors.phone = 'Telefone é obrigatório';
    if (!message) fieldErrors.message = 'Mensagem é obrigatória';

    if (Object.keys(fieldErrors).length > 0) {
      return reply.code(400).send({ error: 'Validation failed', fields: fieldErrors });
    }

    const lead = await prisma.lead.create({
      data: {
        name,
        email,
        phone,
        message,
        source,
        companyName,
        status: LeadStatus.NEW,
      },
    });

    return reply.code(201).send(lead);
  });

  app.patch('/:id', {
    preHandler: async (request) => { await request.jwtVerify(); },
    schema: {
      summary: 'Update lead status',
      tags: ['Leads'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      body: { $ref: 'LeadStatusUpdate#' },
      response: {
        200: { $ref: 'Lead#' },
        400: { type: 'object', additionalProperties: true },
        404: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { status?: string };
    const status = normalizeStatus(body?.status);

    if (!status) {
      return reply.code(400).send({ error: 'Validation failed', fields: { status: 'Status inválido' } });
    }

    const existingLead = await prisma.lead.findUnique({ where: { id } });
    if (!existingLead) {
      return reply.code(404).send({ error: 'Lead not found' });
    }

    const lead = await prisma.lead.update({
      where: { id },
      data: { status },
    });

    return lead;
  });
}
