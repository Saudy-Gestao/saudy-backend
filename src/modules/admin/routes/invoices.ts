import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function invoiceRoutes(app: FastifyInstance) {
  // List invoices
  app.get('/', {
    schema: {
      summary: 'List invoices',
      tags: ['Invoices'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          status: { type: 'string' },
          convention: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { search, status, convention, limit = 50, offset = 0 } = request.query as any;
    const where: any = { isActive: true };
    if (status) where.status = status;
    if (convention) where.convention = convention;
    if (search) where.OR = [
      { number: { contains: search, mode: 'insensitive' } },
      { patientName: { contains: search, mode: 'insensitive' } },
    ];

    const [items, total] = await Promise.all([
      prisma.invoice.findMany({ where, take: limit, skip: offset, orderBy: { issuedAt: 'desc' } }),
      prisma.invoice.count({ where }),
    ]);

    return { items, total };
  });

  // Get invoice
  app.get('/:id', {
    schema: {
      summary: 'Get invoice by ID',
      tags: ['Invoices'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const inv = await prisma.invoice.findUnique({ where: { id } });
    if (!inv) return reply.code(404).send({ error: 'Invoice not found' });
    return inv;
  });

  // Create invoice
  app.post('/', {
    schema: {
      summary: 'Create invoice',
      tags: ['Invoices'],
      body: { $ref: 'InvoiceCreate#' },
      response: { 201: { $ref: 'Invoice#' }, 400: { type: 'object', additionalProperties: true } },
    },
  }, async (request, reply) => {
    const data = request.body as any;

    // Helper to generate a readable invoice number: FAT-YYYY-<timestamp>-<rnd>
    const genNumber = () => {
      const y = new Date().getFullYear();
      const ts = Date.now().toString().slice(-6);
      const rnd = Math.floor(Math.random() * 900 + 100); // 3-digit
      return `FAT-${y}-${ts}-${rnd}`;
    };

    try {
      const total = (data.value || 0) - (data.discount || 0);

      // If client didn't provide number, generate one and attempt create with retries on unique constraint
      let attempts = 0;
      const maxAttempts = 5;
      let created: any = null;
      let numToUse = data.number;

      while (attempts < maxAttempts && !created) {
        attempts++;
        if (!numToUse) numToUse = genNumber();
        try {
          created = await prisma.invoice.create({ data: {
            number: numToUse,
            patientName: data.patientName || null,
            issuedAt: data.issuedAt ? new Date(data.issuedAt) : undefined,
            dueDate: data.dueDate ? new Date(data.dueDate) : null,
            status: data.status || 'EMITIDA',
            convention: data.convention || null,
            value: data.value,
            discount: data.discount || 0,
            total,
            paymentMethod: data.paymentMethod || null,
          } });
        } catch (err: any) {
          // If unique constraint on number, retry with a new generated number
          if (err.code === 'P2002' && err.meta?.target?.includes('number')) {
            request.log.warn({ err, attempt: attempts }, 'Invoice number collision, retrying with a new number');
            numToUse = undefined; // force regeneration
            continue;
          }
          throw err;
        }
      }

      if (!created) {
        throw new Error('Failed to generate unique invoice number after multiple attempts');
      }

      return reply.code(201).send(created);
    } catch (err: any) {
      request.log.error({ err }, 'Failed to create invoice');
      if (err.code === 'P2002') {
        const field = err.meta?.target?.[0] || 'unique';
        return reply.code(400).send({ error: `${field} already exists` });
      }
      return reply.code(400).send({ error: 'Failed to create invoice', details: err.message });
    }
  });

  // Update invoice
  app.put('/:id', {
    schema: {
      summary: 'Update invoice',
      tags: ['Invoices'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { $ref: 'InvoiceUpdate#' },
      response: { 200: { $ref: 'Invoice#' }, 400: { type: 'object', additionalProperties: true } },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const data = request.body as any;
    try {
      if (data.value !== undefined || data.discount !== undefined) {
        const existing = await prisma.invoice.findUnique({ where: { id } });
        const value = data.value !== undefined ? data.value : Number(existing?.value || 0);
        const discount = data.discount !== undefined ? data.discount : Number(existing?.discount || 0);
        data.total = value - discount;
      }
      const inv = await prisma.invoice.update({ where: { id }, data });
      return inv;
    } catch (err: any) {
      request.log.error({ err }, 'Failed to update invoice');
      return reply.code(400).send({ error: 'Failed to update', details: err.message });
    }
  });

  // Delete invoice
  app.delete('/:id', {
    schema: {
      summary: 'Delete invoice',
      tags: ['Invoices'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    await prisma.invoice.delete({ where: { id } });
    return { message: 'Deleted' };
  });
}
