import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function invoiceRoutes(app: FastifyInstance) {
  const toMoney = (value: unknown) => {
    const numeric = Number(value ?? 0);
    return Number.isFinite(numeric) ? numeric : 0;
  };

  const computeInvoiceTotal = (data: any) => {
    const baseValue = toMoney(data.value);
    const commercialDiscount = toMoney(data.discount);
    const packageValue = toMoney(data.packageValue);
    const materialsValue = toMoney(data.materialsValue);
    const feesValue = toMoney(data.feesValue);
    const dailyValue = toMoney(data.dailyValue);
    const gasesValue = toMoney(data.gasesValue);
    const opmeValue = toMoney(data.opmeValue);
    const expectedDiscountValue = toMoney(data.expectedDiscountValue);
    const expectedGlosaValue = toMoney(data.expectedGlosaValue);

    return baseValue
      + packageValue
      + materialsValue
      + feesValue
      + dailyValue
      + gasesValue
      + opmeValue
      - commercialDiscount
      - expectedDiscountValue
      - expectedGlosaValue;
  };

  const parseDateOnly = (value?: string | null) => {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match) {
      const [, year, month, day] = match;
      return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0));
    }
    return new Date(value);
  };

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
      const total = computeInvoiceTotal(data);

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
            sourceAppointmentId: data.sourceAppointmentId || null,
            sourceConsultationId: data.sourceConsultationId || null,
            patientName: data.patientName || null,
            beneficiaryCardNumber: data.beneficiaryCardNumber || null,
            beneficiaryPlan: data.beneficiaryPlan || null,
            beneficiaryCardExpiry: data.beneficiaryCardExpiry || null,
            beneficiaryStatus: data.beneficiaryStatus || null,
            holderName: data.holderName || null,
            holderDocument: data.holderDocument || null,
            dependentName: data.dependentName || null,
            dependentRelationship: data.dependentRelationship || null,
            guideType: data.guideType || null,
            operatorGuideNumber: data.operatorGuideNumber || null,
            authorizationPassword: data.authorizationPassword || null,
            authorizationDate: parseDateOnly(data.authorizationDate),
            authorizationExpiryDate: parseDateOnly(data.authorizationExpiryDate),
            authorizedAttendanceType: data.authorizedAttendanceType || null,
            packageValue: data.packageValue ?? null,
            materialsValue: data.materialsValue ?? null,
            feesValue: data.feesValue ?? null,
            dailyValue: data.dailyValue ?? null,
            gasesValue: data.gasesValue ?? null,
            opmeValue: data.opmeValue ?? null,
            expectedDiscountValue: data.expectedDiscountValue ?? null,
            expectedGlosaValue: data.expectedGlosaValue ?? null,
            cidCode: data.cidCode || null,
            clinicalIndication: data.clinicalIndication || null,
            requestingProfessionalName: data.requestingProfessionalName || null,
            requestingProfessionalCpf: data.requestingProfessionalCpf || null,
            requestingProfessionalCouncil: data.requestingProfessionalCouncil || null,
            requestingProfessionalCouncilUf: data.requestingProfessionalCouncilUf || null,
            requestingProfessionalCouncilNumber: data.requestingProfessionalCouncilNumber || null,
            requestingProfessionalCbo: data.requestingProfessionalCbo || null,
            executingProfessionalName: data.executingProfessionalName || null,
            executingProfessionalCpf: data.executingProfessionalCpf || null,
            executingProfessionalCouncil: data.executingProfessionalCouncil || null,
            executingProfessionalCouncilUf: data.executingProfessionalCouncilUf || null,
            executingProfessionalCouncilNumber: data.executingProfessionalCouncilNumber || null,
            executingProfessionalCbo: data.executingProfessionalCbo || null,
            issuedAt: data.issuedAt ? new Date(data.issuedAt) : undefined,
            dueDate: parseDateOnly(data.dueDate),
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
    const data = { ...(request.body as any) };
    try {
      if (data.dueDate !== undefined) {
        data.dueDate = parseDateOnly(data.dueDate);
      }
      if (data.authorizationDate !== undefined) {
        data.authorizationDate = parseDateOnly(data.authorizationDate);
      }
      if (data.authorizationExpiryDate !== undefined) {
        data.authorizationExpiryDate = parseDateOnly(data.authorizationExpiryDate);
      }
      if (
        data.value !== undefined
        || data.discount !== undefined
        || data.packageValue !== undefined
        || data.materialsValue !== undefined
        || data.feesValue !== undefined
        || data.dailyValue !== undefined
        || data.gasesValue !== undefined
        || data.opmeValue !== undefined
        || data.expectedDiscountValue !== undefined
        || data.expectedGlosaValue !== undefined
      ) {
        const existing = await prisma.invoice.findUnique({ where: { id } });
        const mergedData = {
          value: data.value !== undefined ? data.value : Number(existing?.value || 0),
          discount: data.discount !== undefined ? data.discount : Number(existing?.discount || 0),
          packageValue: data.packageValue !== undefined ? data.packageValue : Number(existing?.packageValue || 0),
          materialsValue: data.materialsValue !== undefined ? data.materialsValue : Number(existing?.materialsValue || 0),
          feesValue: data.feesValue !== undefined ? data.feesValue : Number(existing?.feesValue || 0),
          dailyValue: data.dailyValue !== undefined ? data.dailyValue : Number(existing?.dailyValue || 0),
          gasesValue: data.gasesValue !== undefined ? data.gasesValue : Number(existing?.gasesValue || 0),
          opmeValue: data.opmeValue !== undefined ? data.opmeValue : Number(existing?.opmeValue || 0),
          expectedDiscountValue: data.expectedDiscountValue !== undefined ? data.expectedDiscountValue : Number(existing?.expectedDiscountValue || 0),
          expectedGlosaValue: data.expectedGlosaValue !== undefined ? data.expectedGlosaValue : Number(existing?.expectedGlosaValue || 0),
        };
        data.total = computeInvoiceTotal(mergedData);
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
