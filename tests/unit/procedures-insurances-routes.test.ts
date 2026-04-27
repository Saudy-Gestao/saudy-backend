import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import insuranceRoutes from '../../src/modules/procedures/routes/insurances';
import prisma from '../../src/modules/procedures/lib/prisma';

vi.mock('../../src/modules/procedures/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    insurance: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    subInsurance: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

const mockedPrisma = prisma as any;

const tx = {
  insurance: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  subInsurance: {
    createMany: vi.fn(),
    deleteMany: vi.fn(),
  },
};

async function buildApp(opts?: { unauthorized?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1' };
  });

  await app.register(insuranceRoutes, { prefix: '/insurances' });
  return app;
}

describe('procedures insurances routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b-1' } } });
    mockedPrisma.insurance.findMany.mockResolvedValue([{ id: 'i-1' }]);
    mockedPrisma.insurance.count.mockResolvedValue(1);
    mockedPrisma.insurance.findUnique.mockResolvedValue(null);
    mockedPrisma.insurance.delete.mockResolvedValue({ id: 'i-1' });

    tx.insurance.create.mockResolvedValue({ id: 'i-1' });
    tx.insurance.findUnique.mockResolvedValue({ id: 'i-1', subInsurances: [] });
    tx.insurance.update.mockResolvedValue({ id: 'i-1' });
    tx.subInsurance.createMany.mockResolvedValue({ count: 1 });
    tx.subInsurance.deleteMany.mockResolvedValue({ count: 1 });

    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));
  });

  it('handles auth and list/get', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/insurances' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    const app = await buildApp();

    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/insurances' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/insurances?search=amil&isActive=true' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    res = await app.inject({ method: 'GET', url: '/insurances/i-1' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.insurance.findUnique.mockResolvedValueOnce({ id: 'i-1', branchId: 'other' });
    res = await app.inject({ method: 'GET', url: '/insurances/i-1' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.insurance.findUnique.mockResolvedValueOnce({ id: 'i-1', branchId: 'b-1' });
    res = await app.inject({ method: 'GET', url: '/insurances/i-1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('creates insurance and handles errors', async () => {
    const app = await buildApp();

    mockedPrisma.$transaction.mockRejectedValueOnce(new Error('boom')).mockImplementationOnce(async (cb: any) => cb(tx));
    let res = await app.inject({
      method: 'POST',
      url: '/insurances',
      payload: { name: 'Unimed', subInsurances: [' A ', 'A', 'B'] },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/insurances',
      payload: { name: 'Unimed', subInsurances: [' A ', 'A', 'B'] },
    });
    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it('updates and deletes insurance', async () => {
    const app = await buildApp();

    mockedPrisma.insurance.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'i-1', branchId: 'other' })
      .mockResolvedValueOnce({ id: 'i-1', branchId: '' })
      .mockResolvedValueOnce({ id: 'i-1', branchId: 'b-1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'i-1', branchId: 'other' })
      .mockResolvedValueOnce({ id: 'i-1', branchId: 'b-1' });

    mockedPrisma.$transaction.mockRejectedValueOnce(new Error('bad update')).mockImplementation(async (cb: any) => cb(tx));

    let res = await app.inject({ method: 'PUT', url: '/insurances/i-1', payload: { name: 'X' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/insurances/i-1', payload: { name: 'X' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/insurances/i-1', payload: { name: 'X', subInsurances: ['S1'], tissVersao: '' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PUT', url: '/insurances/i-1', payload: { name: 'X', subInsurances: [] } });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'DELETE', url: '/insurances/i-1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/insurances/i-1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/insurances/i-1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });
});
