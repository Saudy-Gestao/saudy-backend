import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import financeRoutes from '../../src/modules/admin/routes/finance';
import prisma from '../../src/modules/admin/lib/prisma';

vi.mock('../../src/modules/admin/lib/prisma', () => ({
  default: {
    financeEntry: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

const mockedPrisma = prisma as any;

async function buildApp() {
  const app = Fastify();
  app.addSchema({ $id: 'FinanceEntryCreate', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'FinanceEntryUpdate', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'FinanceEntry', type: 'object', additionalProperties: true });
  await app.register(financeRoutes, { prefix: '/finance' });
  return app;
}

describe('admin finance routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists entries with filters', async () => {
    mockedPrisma.financeEntry.findMany.mockResolvedValue([{ id: '1' }]);
    mockedPrisma.financeEntry.count.mockResolvedValue(1);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/finance?type=IN&search=maria' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [{ id: '1' }], total: 1 });
    expect(mockedPrisma.financeEntry.findMany).toHaveBeenCalled();
    await app.close();
  });

  it('gets by id and returns 404 when missing', async () => {
    mockedPrisma.financeEntry.findUnique.mockResolvedValueOnce({ id: '1' }).mockResolvedValueOnce(null);

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/finance/1' });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: '/finance/2' });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('creates and handles create errors', async () => {
    mockedPrisma.financeEntry.create.mockResolvedValueOnce({ id: '1' }).mockRejectedValueOnce(new Error('fail'));

    const app = await buildApp();

    let res = await app.inject({
      method: 'POST',
      url: '/finance',
      payload: { type: 'IN', value: 100, discount: 10 },
    });
    expect(res.statusCode).toBe(201);

    res = await app.inject({
      method: 'POST',
      url: '/finance',
      payload: { type: 'IN', value: 100 },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('updates, recalculates total and handles errors', async () => {
    mockedPrisma.financeEntry.findUnique.mockResolvedValue({ value: 100, discount: 5 });
    mockedPrisma.financeEntry.update.mockResolvedValueOnce({ id: '1' }).mockRejectedValueOnce(new Error('fail'));

    const app = await buildApp();

    let res = await app.inject({
      method: 'PUT',
      url: '/finance/1',
      payload: { value: 200 },
    });
    expect(res.statusCode).toBe(200);

    res = await app.inject({
      method: 'PUT',
      url: '/finance/1',
      payload: { value: 200 },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('deletes entries', async () => {
    mockedPrisma.financeEntry.delete.mockResolvedValue({});

    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/finance/1' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'Deleted' });
    await app.close();
  });

  it('lists with status filter and creates with explicit optional fields', async () => {
    mockedPrisma.financeEntry.findMany.mockResolvedValueOnce([{ id: 's-1' }]);
    mockedPrisma.financeEntry.count.mockResolvedValueOnce(1);
    mockedPrisma.financeEntry.create
      .mockResolvedValueOnce({ id: 'c-1' })
      .mockResolvedValueOnce({ id: 'c-2' });

    const app = await buildApp();

    const listRes = await app.inject({ method: 'GET', url: '/finance?status=PAID' });
    expect(listRes.statusCode).toBe(200);
    expect(mockedPrisma.financeEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'PAID' }),
    }));

    const createRes = await app.inject({
      method: 'POST',
      url: '/finance',
      payload: {
        type: 'OUT',
        value: 150,
        discount: 10,
        category: 'UTILITIES',
        description: 'Electricity bill',
        dueDate: '2026-01-20',
        status: 'PAID',
        paymentMethod: 'PIX',
        relatedName: 'Light Company',
      },
    });
    expect(createRes.statusCode).toBe(201);

    const createCallArg = mockedPrisma.financeEntry.create.mock.calls[0][0];
    expect(createCallArg.data.category).toBe('UTILITIES');
    expect(createCallArg.data.status).toBe('PAID');

    const createZeroValueRes = await app.inject({
      method: 'POST',
      url: '/finance',
      payload: {
        type: 'IN',
        value: 0,
      },
    });
    expect(createZeroValueRes.statusCode).toBe(201);

    await app.close();
  });

  it('updates without total recalculation and recalculates using fallback value when existing is missing', async () => {
    mockedPrisma.financeEntry.update
      .mockResolvedValueOnce({ id: 'u-1', status: 'PAID' })
      .mockResolvedValueOnce({ id: 'u-2', total: -7 })
      .mockResolvedValueOnce({ id: 'u-3', total: -4 })
      .mockResolvedValueOnce({ id: 'u-4', total: 3 });
    mockedPrisma.financeEntry.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ value: 0, discount: 0 })
      .mockResolvedValueOnce({ value: 5, discount: 0 });

    const app = await buildApp();

    const noRecalcRes = await app.inject({
      method: 'PUT',
      url: '/finance/u-1',
      payload: { status: 'PAID' },
    });
    expect(noRecalcRes.statusCode).toBe(200);
    expect(mockedPrisma.financeEntry.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.financeEntry.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'u-1' },
      data: { status: 'PAID' },
    });

    const fallbackRes = await app.inject({
      method: 'PUT',
      url: '/finance/u-2',
      payload: { discount: 7 },
    });
    expect(fallbackRes.statusCode).toBe(200);
    expect(mockedPrisma.financeEntry.findUnique).toHaveBeenCalledWith({ where: { id: 'u-2' } });
    expect(mockedPrisma.financeEntry.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'u-2' },
      data: { discount: 7, total: -7 },
    });

    const zeroValueFallbackRes = await app.inject({
      method: 'PUT',
      url: '/finance/u-3',
      payload: { discount: 4 },
    });
    expect(zeroValueFallbackRes.statusCode).toBe(200);

    const zeroDiscountFallbackRes = await app.inject({
      method: 'PUT',
      url: '/finance/u-4',
      payload: { value: 3 },
    });
    expect(zeroDiscountFallbackRes.statusCode).toBe(200);

    await app.close();
  });
});
