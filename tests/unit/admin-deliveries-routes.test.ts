import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import deliveryRoutes from '../../src/modules/admin/routes/deliveries';
import prisma from '../../src/modules/admin/lib/prisma';

vi.mock('../../src/modules/admin/lib/prisma', () => ({
  default: {
    delivery: {
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
  app.addSchema({ $id: 'DeliveryCreate', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'DeliveryUpdate', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'Delivery', type: 'object', additionalProperties: true });
  await app.register(deliveryRoutes, { prefix: '/deliveries' });
  return app;
}

describe('admin deliveries routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists deliveries with filters', async () => {
    mockedPrisma.delivery.findMany.mockResolvedValue([{ id: '1' }]);
    mockedPrisma.delivery.count.mockResolvedValue(1);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/deliveries?status=DISPONIVEL&search=maria' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [{ id: '1' }], total: 1 });
    await app.close();
  });

  it('gets by id and 404 when not found', async () => {
    mockedPrisma.delivery.findUnique.mockResolvedValueOnce({ id: '1' }).mockResolvedValueOnce(null);

    const app = await buildApp();
    let res = await app.inject({ method: 'GET', url: '/deliveries/1' });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: '/deliveries/2' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('creates and handles create errors', async () => {
    mockedPrisma.delivery.create.mockResolvedValueOnce({ id: '1' }).mockRejectedValueOnce(new Error('fail'));

    const app = await buildApp();
    let res = await app.inject({
      method: 'POST',
      url: '/deliveries',
      payload: { patientName: 'Maria', documentType: 'LAUDO' },
    });
    expect(res.statusCode).toBe(201);

    res = await app.inject({
      method: 'POST',
      url: '/deliveries',
      payload: { patientName: 'Maria', documentType: 'LAUDO' },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('updates and handles errors', async () => {
    mockedPrisma.delivery.update.mockResolvedValueOnce({ id: '1' }).mockRejectedValueOnce(new Error('fail'));

    const app = await buildApp();
    let res = await app.inject({
      method: 'PUT',
      url: '/deliveries/1',
      payload: { availableAt: '2026-01-01T10:00:00.000Z' },
    });
    expect(res.statusCode).toBe(200);

    res = await app.inject({
      method: 'PUT',
      url: '/deliveries/1',
      payload: { availableAt: '2026-01-01T10:00:00.000Z' },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('deletes deliveries', async () => {
    mockedPrisma.delivery.delete.mockResolvedValue({});

    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/deliveries/1' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'Deleted' });
    await app.close();
  });
});
