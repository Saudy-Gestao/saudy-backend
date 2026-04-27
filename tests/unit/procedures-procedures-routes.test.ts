import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import procedureRoutes from '../../src/modules/procedures/routes/procedures';
import prisma from '../../src/modules/procedures/lib/prisma';

vi.mock('../../src/modules/procedures/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    procedure: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    procedureDoctor: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    procedureMaterial: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

const mockedPrisma = prisma as any;

async function buildApp(opts?: { unauthorized?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1' };
  });

  await app.register(procedureRoutes, { prefix: '/procedures' });
  return app;
}

describe('procedures routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b-1' } } });
    mockedPrisma.procedure.findMany.mockResolvedValue([{ id: 'p-1' }]);
    mockedPrisma.procedure.count.mockResolvedValue(1);
    mockedPrisma.procedure.findFirst.mockResolvedValue(null);
    mockedPrisma.procedure.create.mockResolvedValue({ id: 'p-1' });
    mockedPrisma.procedure.update.mockResolvedValue({ id: 'p-1' });
    mockedPrisma.procedure.delete.mockResolvedValue({ id: 'p-1' });
    mockedPrisma.procedureDoctor.deleteMany.mockResolvedValue({ count: 1 });
    mockedPrisma.procedureDoctor.createMany.mockResolvedValue({ count: 1 });
    mockedPrisma.procedureMaterial.deleteMany.mockResolvedValue({ count: 1 });
    mockedPrisma.procedureMaterial.createMany.mockResolvedValue({ count: 1 });

    mockedPrisma.$transaction.mockImplementation(async (arg: any) => {
      if (Array.isArray(arg)) return arg;
      return arg;
    });
  });

  it('handles auth and list/get', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/procedures' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    const app = await buildApp();

    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/procedures' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/procedures?search=eco&acceptsInsurance=true' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    res = await app.inject({ method: 'GET', url: '/procedures/p-1' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.procedure.findFirst.mockResolvedValueOnce({ id: 'p-1' });
    res = await app.inject({ method: 'GET', url: '/procedures/p-1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('creates procedure and handles create failure', async () => {
    const app = await buildApp();

    mockedPrisma.procedure.create.mockRejectedValueOnce(new Error('boom'));
    let res = await app.inject({
      method: 'POST',
      url: '/procedures',
      payload: { name: 'USG', appointmentType: 'EXAME', acceptsInsurance: true, acceptedInsurances: [' A ', ''], doctorIds: ['d-1'], procedureMaterials: [{ inventoryItemId: 'i-1', quantity: 2 }] },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/procedures',
      payload: { name: 'USG', appointmentType: 'EXAME', acceptsInsurance: false, modalities: ['XR'] },
    });
    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it('updates and deletes procedures', async () => {
    const app = await buildApp();

    mockedPrisma.procedure.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'p-1', branchId: 'b-1' })
      .mockResolvedValueOnce({ id: 'p-1', branchId: 'b-1' })
      .mockResolvedValueOnce({ id: 'p-1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'p-1' });

    mockedPrisma.$transaction.mockRejectedValueOnce(new Error('tx failed')).mockResolvedValue([]);

    let res = await app.inject({ method: 'PUT', url: '/procedures/p-1', payload: { name: 'novo' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/procedures/p-1', payload: { name: 'novo', doctors: [{ doctorId: 'd-1', doctorName: 'Dr' }], procedureMaterials: [{ inventoryItemId: 'i-1', quantity: 1 }], acceptsInsurance: false } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PUT', url: '/procedures/p-1', payload: { name: 'novo', doctorIds: ['d-1'], tussCode: '12.34', tussTableCode: '99', durationMinutes: '' } });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'DELETE', url: '/procedures/p-1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/procedures/p-1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });
});
