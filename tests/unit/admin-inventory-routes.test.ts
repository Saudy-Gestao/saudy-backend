import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import inventoryRoutes from '../../src/modules/admin/routes/inventory';
import prisma from '../../src/modules/admin/lib/prisma';

vi.mock('../../src/modules/admin/lib/prisma', () => ({
  default: {
    inventoryItem: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    adminUser: { findUnique: vi.fn(), findMany: vi.fn() },
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    inventoryMovement: { findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
  },
}));

const mockedPrisma = prisma as any;

async function buildApp() {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    this.user = { id: 'admin-1', admHubOnly: true };
  });
  await app.register(inventoryRoutes, { prefix: '/inventory' });
  return app;
}

describe('admin inventory routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.adminUser.findUnique.mockResolvedValue({ name: 'Admin' });
    mockedPrisma.user.findUnique.mockResolvedValue({ name: 'User' });
    mockedPrisma.adminUser.findMany.mockResolvedValue([]);
    mockedPrisma.user.findMany.mockResolvedValue([]);
    mockedPrisma.inventoryMovement.findMany.mockResolvedValue([]);
    mockedPrisma.inventoryMovement.count.mockResolvedValue(0);
    mockedPrisma.inventoryMovement.create.mockResolvedValue({ id: 'movement-1' });
  });

  it('lists inventory with filters', async () => {
    mockedPrisma.inventoryItem.findMany.mockResolvedValue([{ id: '1' }]);
    mockedPrisma.inventoryItem.count.mockResolvedValue(1);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/inventory?search=agulha&category=MATERIAL' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [{ id: '1' }], total: 1 });
    expect(mockedPrisma.inventoryItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ category: 'MATERIAL' }) }));

    await app.close();
  });

  it('gets by id and 404 when missing', async () => {
    mockedPrisma.inventoryItem.findUnique.mockResolvedValueOnce({ id: '1' }).mockResolvedValueOnce(null);

    const app = await buildApp();
    let res = await app.inject({ method: 'GET', url: '/inventory/1' });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: '/inventory/2' });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('validates required fields on create', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/inventory',
      payload: {
        code: '',
        name: '',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'Validation failed',
      fields: {
        code: 'Código é obrigatório',
        name: 'Nome do item é obrigatório',
      },
    });

    await app.close();
  });

  it('creates item and computes low status when quantity <= minQuantity', async () => {
    mockedPrisma.inventoryItem.create.mockResolvedValue({ id: '1' });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/inventory',
      payload: {
        code: 'COD-1',
        name: 'Luva',
        quantity: 2,
        minQuantity: 2,
        expiryDate: '2026-05-01',
      },
    });

    expect(res.statusCode).toBe(201);
    const data = mockedPrisma.inventoryItem.create.mock.calls[0][0].data;
    expect(data.status).toBe('LOW');
    expect(data.expiryDate).toBeInstanceOf(Date);

    await app.close();
  });

  it('handles unique code conflict and generic create error', async () => {
    mockedPrisma.inventoryItem.create
      .mockRejectedValueOnce({ code: 'P2002', meta: { target: ['code'] } })
      .mockRejectedValueOnce(new Error('create failed'));

    const app = await buildApp();

    let res = await app.inject({
      method: 'POST',
      url: '/inventory',
      payload: { code: 'COD-1', name: 'Luva', expiryDate: '2026-05-01' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Validation failed', fields: { code: 'Código já existe' } });

    res = await app.inject({
      method: 'POST',
      url: '/inventory',
      payload: { code: 'COD-1', name: 'Luva', expiryDate: '2026-05-01' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Failed to create item', details: 'create failed' });

    await app.close();
  });

  it('validates update payload fields', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/inventory/1',
      payload: {
        code: ' ',
        name: ' ',
        quantity: 'x',
        minQuantity: 'y',
        unitPrice: 'z',
        expiryDate: 'invalid-date',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'Validation failed',
      fields: {
        code: 'Código não pode ser vazio',
        name: 'Nome do item não pode ser vazio',
        quantity: 'Quantidade inválida',
        minQuantity: 'Quantidade mínima inválida',
        unitPrice: 'Preço inválido',
        expiryDate: 'Data de validade inválida',
      },
    });

    await app.close();
  });

  it('returns 404 when updating a missing item', async () => {
    mockedPrisma.inventoryItem.findUnique.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/inventory/1',
      payload: { quantity: 3 },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Item not found' });

    await app.close();
  });

  it('updates item and computes available status', async () => {
    mockedPrisma.inventoryItem.findUnique.mockResolvedValue({ id: '1', quantity: 1, minQuantity: 5 });
    mockedPrisma.inventoryItem.update.mockResolvedValue({ id: '1' });

    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/inventory/1',
      payload: { quantity: 10, minQuantity: 2 },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.inventoryItem.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: '1' },
      data: expect.objectContaining({ quantity: 10, status: 'AVAILABLE' }),
    }));

    await app.close();
  });

  it('handles update unique conflict and generic update error', async () => {
    mockedPrisma.inventoryItem.findUnique.mockResolvedValue({ id: '1', quantity: 1, minQuantity: 0 });
    mockedPrisma.inventoryItem.update
      .mockRejectedValueOnce({ code: 'P2002', meta: { target: ['code'] } })
      .mockRejectedValueOnce(new Error('update failed'));

    const app = await buildApp();

    let res = await app.inject({
      method: 'PUT',
      url: '/inventory/1',
      payload: { code: 'COD-2' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Validation failed', fields: { code: 'Código já existe' } });

    res = await app.inject({
      method: 'PUT',
      url: '/inventory/1',
      payload: { code: 'COD-3' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Failed to update', details: 'update failed' });

    await app.close();
  });

  it('deletes inventory item', async () => {
    mockedPrisma.inventoryItem.delete.mockResolvedValue({});

    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/inventory/1' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'Deleted' });

    await app.close();
  });
});
