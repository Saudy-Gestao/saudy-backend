import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import branchRoutes from '../../src/modules/auth/routes/branches';
import prisma from '../../src/modules/auth/lib/prisma';

vi.mock('../../src/modules/auth/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    branch: {
      findMany: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

const mockedPrisma = prisma as any;

function makeTx() {
  return {
    branch: {
      updateMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  };
}

async function buildApp() {
  const app = Fastify();
  app.decorateRequest('jwtVerify', async function jwtVerify() {});
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    (request as any).user = { id: 'u-1' };
  });

  app.addSchema({ $id: 'Branch', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'BranchCreate', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'BranchUpdate', type: 'object', additionalProperties: true });

  await app.register(branchRoutes);
  return app;
}

describe('auth branches routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { companyId: 'c1' } } });
  });

  it('lists branches and ensures one matriz exists', async () => {
    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    mockedPrisma.branch.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'b1', isMatriz: false }, { id: 'b2', isMatriz: false }]);
    mockedPrisma.branch.update.mockResolvedValue({});

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/branches' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/branches' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);

    res = await app.inject({ method: 'GET', url: '/branches' });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].isMatriz).toBe(true);

    await app.close();
  });

  it('creates branches handling matriz logic', async () => {
    const tx = makeTx();
    tx.branch.create.mockResolvedValue({ id: 'b1', isMatriz: true });
    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));
    mockedPrisma.branch.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'exists', isMatriz: true });

    const app = await buildApp();

    let res = await app.inject({
      method: 'POST',
      url: '/branches',
      payload: { companyId: 'c1', tradeName: 'Matriz', address: 'A', phone: '1' },
    });
    expect(res.statusCode).toBe(200);
    expect(tx.branch.updateMany).toHaveBeenCalled();

    res = await app.inject({
      method: 'POST',
      url: '/branches',
      payload: { companyId: 'c1', tradeName: 'Filial', address: 'B', phone: '2', type: 'Filial' },
    });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('gets branch by id', async () => {
    mockedPrisma.branch.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'b1' });

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/branches/b1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/branches/b1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('updates branch with matriz and filial rules and handles errors', async () => {
    const tx = makeTx();
    tx.branch.update.mockResolvedValue({ id: 'b1', isMatriz: false });
    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));

    mockedPrisma.branch.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'b1', companyId: 'c1', isMatriz: true })
      .mockResolvedValueOnce({ id: 'b1', companyId: 'c1', isMatriz: true })
      .mockRejectedValueOnce(new Error('oops'));

    mockedPrisma.branch.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'b2', isMatriz: true });

    const app = await buildApp();

    let res = await app.inject({ method: 'PUT', url: '/branches/b1', payload: { tradeName: 'X' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/branches/b1', payload: { type: 'Filial' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PUT', url: '/branches/b1', payload: { type: 'Matriz' } });
    expect(res.statusCode).toBe(200);
    expect(tx.branch.updateMany).toHaveBeenCalled();

    res = await app.inject({ method: 'PUT', url: '/branches/b1', payload: { tradeName: 'Y' } });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('deletes branch with matriz protection', async () => {
    mockedPrisma.branch.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'b1', isMatriz: true })
      .mockResolvedValueOnce({ id: 'b1', isMatriz: false })
      .mockRejectedValueOnce(new Error('x'));
    mockedPrisma.branch.delete.mockResolvedValue({});

    const app = await buildApp();

    let res = await app.inject({ method: 'DELETE', url: '/branches/b1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/branches/b1' });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'DELETE', url: '/branches/b1' });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'DELETE', url: '/branches/b1' });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});
