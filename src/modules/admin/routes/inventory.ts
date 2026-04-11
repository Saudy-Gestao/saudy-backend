import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function inventoryRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  const recomputeStatus = (quantity: number, minQuantity?: number | null, expiryDate?: Date | null) => {
    if (expiryDate && expiryDate.getTime() < Date.now()) return 'EXPIRED';
    if (quantity <= 0) return 'OUT_OF_STOCK';
    if (Number.isFinite(Number(minQuantity || 0)) && quantity <= Number(minQuantity || 0)) return 'LOW';
    return 'AVAILABLE';
  };

  const resolveActor = async (request: any) => {
    const actor = request?.user as any;
    const actorId = actor?.id ? String(actor.id) : '';
    const isAdmHubOnly = Boolean(actor?.admHubOnly);
    let actorName: string | null = null;

    if (actorId) {
      if (isAdmHubOnly) {
        const admin = await prisma.adminUser.findUnique({
          where: { id: actorId },
          select: { name: true },
        });
        actorName = admin?.name ? String(admin.name) : 'Administrador';
      } else {
        const user = await prisma.user.findUnique({
          where: { id: actorId },
          select: { name: true },
        });
        actorName = user?.name ? String(user.name) : 'Usuário';
      }
    }

    return {
      actorId: actorId || null,
      actorName,
    };
  };

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
    if (data?.expiryDate && isNaN(Date.parse(String(data.expiryDate)))) fieldErrors.expiryDate = 'Data de validade inválida';
    if (data?.quantity !== undefined && Number.isNaN(Number(data.quantity))) fieldErrors.quantity = 'Quantidade inválida';
    if (data?.minQuantity !== undefined && Number.isNaN(Number(data.minQuantity))) fieldErrors.minQuantity = 'Quantidade mínima inválida';
    if (data?.unitPrice !== undefined && Number.isNaN(Number(data.unitPrice))) fieldErrors.unitPrice = 'Preço inválido';

    if (Object.keys(fieldErrors).length > 0) {
      return reply.code(400).send({ error: 'Validation failed', fields: fieldErrors });
    }

    // derive status from provided quantities when creating
    const quantity = Number.isFinite(Number(data.quantity)) ? Number(data.quantity) : 0;
    const minQuantity = Number.isFinite(Number(data.minQuantity)) ? Number(data.minQuantity) : 0;
    const expiryDate = data.expiryDate ? new Date(data.expiryDate) : null;
    const status = (data.status ? String(data.status).toUpperCase() : recomputeStatus(quantity, minQuantity, expiryDate));

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
        expiryDate,
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

      const expiryDate = data.expiryDate !== undefined
        ? (data.expiryDate ? new Date(data.expiryDate) : null)
        : existing.expiryDate;
      const computedStatus = data.status ? String(data.status).toUpperCase() : recomputeStatus(newQuantity, newMin, expiryDate);

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

  app.get('/:id/movements', {
    schema: {
      summary: 'List inventory item movements',
      tags: ['Inventory'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      querystring: {
        type: 'object',
        properties: { limit: { type: 'number', default: 50 }, offset: { type: 'number', default: 0 } },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const { limit = 50, offset = 0 } = request.query as any;

    const [rawItems, total] = await Promise.all([
      prisma.inventoryMovement.findMany({
        where: { inventoryItemId: id },
        orderBy: { createdAt: 'desc' },
        take: Number(limit || 50),
        skip: Number(offset || 0),
      }),
      prisma.inventoryMovement.count({ where: { inventoryItemId: id } }),
    ]);

    const missingAuthorIds = Array.from(new Set(
      rawItems
        .filter((movement: any) => !movement.createdByName && movement.createdByUserId)
        .map((movement: any) => String(movement.createdByUserId)),
    ));

    let usersById = new Map<string, string>();
    if (missingAuthorIds.length > 0) {
      const [users, admins] = await Promise.all([
        prisma.user.findMany({
          where: { id: { in: missingAuthorIds } },
          select: { id: true, name: true },
        }),
        prisma.adminUser.findMany({
          where: { id: { in: missingAuthorIds } },
          select: { id: true, name: true },
        }),
      ]);
      usersById = new Map<string, string>([
        ...users.map((user: any) => [String(user.id), String(user.name || 'Usuário')]),
        ...admins.map((admin: any) => [String(admin.id), String(admin.name || 'Administrador')]),
      ]);
    }

    const items = rawItems.map((movement: any) => ({
      ...movement,
      createdByName: movement.createdByName
        || (movement.createdByUserId ? (usersById.get(String(movement.createdByUserId)) || null) : null),
    }));

    return { items, total };
  });

  app.get('/:id/lots', {
    schema: {
      summary: 'List inventory item lots',
      tags: ['Inventory'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      querystring: {
        type: 'object',
        properties: { limit: { type: 'number', default: 100 }, offset: { type: 'number', default: 0 } },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const { limit = 100, offset = 0 } = request.query as any;

    const [items, total] = await Promise.all([
      prisma.inventoryLot.findMany({
        where: { inventoryItemId: id },
        orderBy: [
          { expiryDate: 'asc' },
          { createdAt: 'desc' },
        ],
        take: Number(limit || 100),
        skip: Number(offset || 0),
      }),
      prisma.inventoryLot.count({ where: { inventoryItemId: id } }),
    ]);

    return { items, total };
  });

  app.get('/kits', {
    schema: {
      summary: 'List inventory kits',
      tags: ['Inventory'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          limit: { type: 'number', default: 100 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request) => {
    const { search, limit = 100, offset = 0 } = request.query as any;
    const where: any = { isActive: true };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.inventoryKit.findMany({
        where,
        orderBy: { name: 'asc' },
        include: {
          items: {
            include: { inventoryItem: true },
            orderBy: { createdAt: 'asc' },
          },
        },
        take: Number(limit || 100),
        skip: Number(offset || 0),
      }),
      prisma.inventoryKit.count({ where }),
    ]);

    return { items, total };
  });

  app.post('/kits', {
    schema: {
      summary: 'Create inventory kit',
      tags: ['Inventory'],
      body: {
        type: 'object',
        required: ['name', 'items'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                inventoryItemId: { type: 'string' },
                quantity: { type: 'number' },
              },
              required: ['inventoryItemId', 'quantity'],
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as any;
    const name = String(body?.name || '').trim();
    const description = String(body?.description || '').trim() || null;
    const items = Array.isArray(body?.items) ? body.items : [];

    if (!name) return reply.code(400).send({ error: 'Nome do kit é obrigatório' });
    if (!items.length) return reply.code(400).send({ error: 'Informe ao menos 1 item no kit' });

    const normalizedItems = items
      .map((item: any) => ({
        inventoryItemId: String(item?.inventoryItemId || '').trim(),
        quantity: Math.floor(Number(item?.quantity || 0)),
      }))
      .filter((item: any) => item.inventoryItemId && Number.isFinite(item.quantity) && item.quantity > 0);
    if (!normalizedItems.length) return reply.code(400).send({ error: 'Itens do kit inválidos' });

    const created = await prisma.inventoryKit.create({
      data: {
        name,
        description,
        items: {
          createMany: {
            data: normalizedItems,
            skipDuplicates: true,
          },
        },
      },
      include: {
        items: {
          include: { inventoryItem: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    return reply.code(201).send(created);
  });

  app.put('/kits/:kitId', {
    schema: {
      summary: 'Update inventory kit',
      tags: ['Inventory'],
      params: { type: 'object', properties: { kitId: { type: 'string' } }, required: ['kitId'] },
      body: { type: 'object' },
    },
  }, async (request, reply) => {
    const { kitId } = request.params as any;
    const body = request.body as any;
    const existing = await prisma.inventoryKit.findUnique({ where: { id: kitId } });
    if (!existing) return reply.code(404).send({ error: 'Kit não encontrado' });

    const updateData: any = {};
    if (body?.name !== undefined) {
      const name = String(body.name || '').trim();
      if (!name) return reply.code(400).send({ error: 'Nome do kit inválido' });
      updateData.name = name;
    }
    if (body?.description !== undefined) updateData.description = String(body.description || '').trim() || null;
    if (body?.isActive !== undefined) updateData.isActive = Boolean(body.isActive);

    await prisma.$transaction(async (tx: any) => {
      await tx.inventoryKit.update({ where: { id: kitId }, data: updateData });
      if (Array.isArray(body?.items)) {
        const normalizedItems = body.items
          .map((item: any) => ({
            inventoryItemId: String(item?.inventoryItemId || '').trim(),
            quantity: Math.floor(Number(item?.quantity || 0)),
          }))
          .filter((item: any) => item.inventoryItemId && Number.isFinite(item.quantity) && item.quantity > 0);
        await tx.inventoryKitItem.deleteMany({ where: { kitId } });
        if (normalizedItems.length) {
          await tx.inventoryKitItem.createMany({
            data: normalizedItems.map((item: any) => ({ ...item, kitId })),
            skipDuplicates: true,
          });
        }
      }
    });

    const updated = await prisma.inventoryKit.findUnique({
      where: { id: kitId },
      include: {
        items: {
          include: { inventoryItem: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return updated;
  });

  app.post('/:id/lots', {
    schema: {
      summary: 'Create inventory lot',
      tags: ['Inventory'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        required: ['lotCode', 'quantity'],
        properties: {
          lotCode: { type: 'string' },
          quantity: { type: 'number' },
          expiryDate: { type: 'string', format: 'date' },
          unitPrice: { type: 'number' },
          supplier: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const data = request.body as any;

    const lotCode = String(data?.lotCode || '').trim();
    const quantity = Number(data?.quantity);
    const expiryDate = data?.expiryDate ? new Date(String(data.expiryDate)) : null;
    const unitPrice = data?.unitPrice !== undefined && data?.unitPrice !== null ? Number(data.unitPrice) : null;
    const supplier = data?.supplier ? String(data.supplier).trim() : null;
    const notes = data?.notes ? String(data.notes).trim() : null;

    if (!lotCode) {
      return reply.code(400).send({ error: 'Código do lote é obrigatório' });
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return reply.code(400).send({ error: 'Quantidade do lote deve ser maior que zero' });
    }
    if (data?.expiryDate && Number.isNaN(expiryDate?.getTime())) {
      return reply.code(400).send({ error: 'Data de validade inválida' });
    }
    if (unitPrice !== null && Number.isNaN(unitPrice)) {
      return reply.code(400).send({ error: 'Preço unitário inválido' });
    }

    try {
      const { actorId, actorName } = await resolveActor(request);
      const result = await prisma.$transaction(async (tx: any) => {
        const item = await tx.inventoryItem.findUnique({ where: { id } });
        if (!item) throw new Error('ITEM_NOT_FOUND');

        const lot = await tx.inventoryLot.create({
          data: {
            inventoryItemId: id,
            lotCode,
            quantity,
            expiryDate,
            unitPrice,
            supplier,
            notes,
            createdByUserId: actorId,
            createdByName: actorName,
          },
        });

        const resultingQty = Number(item.quantity || 0) + quantity;
        const effectiveExpiryDate = item.expiryDate && expiryDate
          ? (item.expiryDate <= expiryDate ? item.expiryDate : expiryDate)
          : (item.expiryDate || expiryDate);
        const status = recomputeStatus(resultingQty, item.minQuantity, effectiveExpiryDate);

        const updatedItem = await tx.inventoryItem.update({
          where: { id },
          data: {
            quantity: resultingQty,
            expiryDate: effectiveExpiryDate,
            status,
          },
        });

        await tx.inventoryMovement.create({
          data: {
            inventoryItemId: id,
            type: 'ENTRY',
            quantity,
            reason: `Entrada por lote ${lotCode}`,
            notes: notes || 'Cadastro de lote',
            previousQty: Number(item.quantity || 0),
            resultingQty,
            createdByUserId: actorId,
            createdByName: actorName,
          },
        });

        return { lot, item: updatedItem };
      });

      return reply.code(201).send(result);
    } catch (err: any) {
      if (err?.message === 'ITEM_NOT_FOUND') return reply.code(404).send({ error: 'Item não encontrado' });
      if (err?.code === 'P2002') return reply.code(400).send({ error: 'Já existe um lote com esse código para este item' });
      request.log.error({ err }, 'Failed to create inventory lot');
      return reply.code(400).send({ error: 'Falha ao cadastrar lote' });
    }
  });

  app.post('/:id/movements', {
    schema: {
      summary: 'Create inventory movement',
      tags: ['Inventory'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        required: ['type', 'quantity', 'reason'],
        properties: {
          type: { type: 'string', enum: ['ENTRY', 'EXIT', 'ADJUSTMENT'] },
          quantity: { type: 'number' },
          reason: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const { type, quantity, reason, notes } = request.body as any;
    const normalizedType = String(type || '').trim().toUpperCase();
    const qty = Number(quantity);
    const normalizedReason = String(reason || '').trim();

    if (!['ENTRY', 'EXIT', 'ADJUSTMENT'].includes(normalizedType)) {
      return reply.code(400).send({ error: 'Tipo de movimentação inválido' });
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      return reply.code(400).send({ error: 'Quantidade deve ser maior que zero' });
    }
    if (!normalizedReason) {
      return reply.code(400).send({ error: 'Motivo é obrigatório' });
    }

    try {
      const { actorId, actorName } = await resolveActor(request);

      const result = await prisma.$transaction(async (tx: any) => {
        const item = await tx.inventoryItem.findUnique({ where: { id } });
        if (!item) throw new Error('ITEM_NOT_FOUND');

        const previousQty = Number(item.quantity || 0);
        let resultingQty = previousQty;
        if (normalizedType === 'ENTRY') resultingQty = previousQty + qty;
        if (normalizedType === 'EXIT') resultingQty = previousQty - qty;
        if (normalizedType === 'ADJUSTMENT') resultingQty = qty;

        if (resultingQty < 0) throw new Error('NEGATIVE_STOCK');

        const status = recomputeStatus(resultingQty, item.minQuantity, item.expiryDate);
        const updatedItem = await tx.inventoryItem.update({
          where: { id },
          data: { quantity: resultingQty, status },
        });

        const movement = await tx.inventoryMovement.create({
          data: {
            inventoryItemId: id,
            type: normalizedType,
            quantity: qty,
            reason: normalizedReason,
            notes: notes ? String(notes) : null,
            previousQty,
            resultingQty,
            createdByUserId: actorId || null,
            createdByName: actorName,
          },
        });

        return { item: updatedItem, movement };
      });

      return reply.code(201).send(result);
    } catch (err: any) {
      if (err?.message === 'ITEM_NOT_FOUND') return reply.code(404).send({ error: 'Item não encontrado' });
      if (err?.message === 'NEGATIVE_STOCK') return reply.code(400).send({ error: 'Estoque insuficiente para saída' });
      request.log.error({ err }, 'Failed to create inventory movement');
      return reply.code(400).send({ error: 'Falha ao registrar movimentação' });
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
