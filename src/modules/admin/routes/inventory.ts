import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function inventoryRoutes(app: FastifyInstance) {
  app.get('/', {
    schema: {
      summary: 'List inventory items',
      tags: ['Inventory'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          category: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { search, category, limit = 50, offset = 0 } = request.query as any;

    const where: any = { isActive: true };
    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (category) where.category = category;

    const [items, total] = await Promise.all([
      prisma.inventoryItem.findMany({ where, take: limit, skip: offset, orderBy: { name: 'asc' } }),
      prisma.inventoryItem.count({ where }),
    ]);

    return { items, total };
  });

  app.get('/:id', {
    schema: {
      summary: 'Get inventory item by ID',
      tags: ['Inventory'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const item = await prisma.inventoryItem.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: 'Item not found' });
    return item;
  });

  app.post('/', {
    schema: {
      summary: 'Create inventory item',
      tags: ['Inventory'],
      body: {
        type: 'object',
        required: ['code', 'name'],
        properties: {
          code: { type: 'string' },
          name: { type: 'string' },
          category: { type: 'string' },
          unit: { type: 'string' },
          quantity: { type: 'number' },
          minQuantity: { type: 'number' },
          maxQuantity: { type: 'number' },
          unitPrice: { type: 'number' },
          expiryDate: { type: 'string', format: 'date' },
          notes: { type: 'string' },
        },
      },
      response: {
        201: { type: 'object' },
        400: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const data = request.body as any;

    // explicit validation so clients get field-level errors
    const fieldErrors: Record<string, string> = {};
    if (!data?.code || String(data.code).trim() === '') fieldErrors.code = 'Código é obrigatório';
    if (!data?.name || String(data.name).trim() === '') fieldErrors.name = 'Nome do item é obrigatório';
    if (!data?.expiryDate || String(data.expiryDate).trim() === '') fieldErrors.expiryDate = 'Data de validade é obrigatória';
    else if (isNaN(Date.parse(String(data.expiryDate)))) fieldErrors.expiryDate = 'Data de validade inválida';
    if (data?.quantity !== undefined && Number.isNaN(Number(data.quantity))) fieldErrors.quantity = 'Quantidade inválida';
    if (data?.minQuantity !== undefined && Number.isNaN(Number(data.minQuantity))) fieldErrors.minQuantity = 'Quantidade mínima inválida';
    if (data?.unitPrice !== undefined && Number.isNaN(Number(data.unitPrice))) fieldErrors.unitPrice = 'Preço inválido';

    if (Object.keys(fieldErrors).length > 0) {
      return reply.code(400).send({ error: 'Validation failed', fields: fieldErrors });
    }

    // derive status from provided quantities when creating
    const quantity = Number.isFinite(Number(data.quantity)) ? Number(data.quantity) : 0;
    const minQuantity = Number.isFinite(Number(data.minQuantity)) ? Number(data.minQuantity) : 0;
    const status = (data.status ? String(data.status).toUpperCase() : (quantity <= minQuantity ? 'LOW' : 'AVAILABLE'));

    try {
      const item = await prisma.inventoryItem.create({ data: {
        code: data.code,
        name: data.name,
        category: data.category || null,
        unit: data.unit || null,
        quantity: quantity,
        minQuantity: data.minQuantity ?? null,
        maxQuantity: data.maxQuantity ?? null,
        unitPrice: data.unitPrice ? Number(data.unitPrice) : null,
        expiryDate: data.expiryDate ? new Date(data.expiryDate) : null,
        status,
        notes: data.notes || null,
      } });

      return reply.code(201).send(item);
    } catch (err: any) {
      request.log.error({ err }, 'Failed to create inventory item');
      // handle unique/code conflicts gracefully
      if (err?.code === 'P2002' && err?.meta?.target?.includes('code')) {
        return reply.code(400).send({ error: 'Validation failed', fields: { code: 'Código já existe' } });
      }
      return reply.code(400).send({ error: 'Failed to create item', details: err.message });
    }
  });

  app.put('/:id', {
    schema: {
      summary: 'Update inventory item',
      tags: ['Inventory'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object' },
      response: { 200: { type: 'object' }, 400: { type: 'object', additionalProperties: true }, 404: { type: 'object', additionalProperties: true } },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const data = request.body as any;

    // validate provided fields
    const fieldErrors: Record<string, string> = {};
    if (data?.code !== undefined && String(data.code).trim() === '') fieldErrors.code = 'Código não pode ser vazio';
    if (data?.name !== undefined && String(data.name).trim() === '') fieldErrors.name = 'Nome do item não pode ser vazio';
    if (data?.quantity !== undefined && Number.isNaN(Number(data.quantity))) fieldErrors.quantity = 'Quantidade inválida';
    if (data?.minQuantity !== undefined && Number.isNaN(Number(data.minQuantity))) fieldErrors.minQuantity = 'Quantidade mínima inválida';
    if (data?.unitPrice !== undefined && Number.isNaN(Number(data.unitPrice))) fieldErrors.unitPrice = 'Preço inválido';
    if (data?.expiryDate !== undefined && data.expiryDate && isNaN(Date.parse(String(data.expiryDate)))) fieldErrors.expiryDate = 'Data de validade inválida';

    if (Object.keys(fieldErrors).length > 0) return reply.code(400).send({ error: 'Validation failed', fields: fieldErrors });

    try {
      // fetch existing to compute new status when quantity/minQuantity are partially provided
      const existing = await prisma.inventoryItem.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: 'Item not found' });

      const newQuantity = data.quantity !== undefined ? Number(data.quantity) : existing.quantity;
      const newMin = data.minQuantity !== undefined ? Number(data.minQuantity) : (existing.minQuantity ?? 0);

      const computedStatus = data.status ? String(data.status).toUpperCase() : (newQuantity <= newMin ? 'LOW' : 'AVAILABLE');

      const toUpdate = { ...data, quantity: data.quantity !== undefined ? newQuantity : undefined, minQuantity: data.minQuantity !== undefined ? data.minQuantity : undefined, status: computedStatus };

      const item = await prisma.inventoryItem.update({ where: { id }, data: toUpdate });
      return item;
    } catch (err: any) {
      request.log.error({ err }, 'Failed to update inventory item');
      if (err?.code === 'P2002' && err?.meta?.target?.includes('code')) {
        return reply.code(400).send({ error: 'Validation failed', fields: { code: 'Código já existe' } });
      }
      return reply.code(400).send({ error: 'Failed to update', details: err.message });
    }
  });

  app.delete('/:id', {
    schema: {
      summary: 'Delete inventory item',
      tags: ['Inventory'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    await prisma.inventoryItem.delete({ where: { id } });
    return { message: 'Deleted' };
  });
}
