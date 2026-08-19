import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import sectorRoutes from '../../src/modules/auth/routes/sectors';
import prisma from '../../src/modules/auth/lib/prisma';

vi.mock('../../src/modules/auth/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    branch: { findMany: vi.fn(), findFirst: vi.fn() },
    especialidade: { findUnique: vi.fn() },
    sector: {
      findMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

const mockedPrisma = prisma as any;

async function buildApp() {
  const app = Fastify();
  app.decorateRequest('jwtVerify', async function jwtVerify() {});
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    (request as any).user = { id: 'u-1' };
  });

  app.addSchema({ $id: 'Sector', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'SectorCreate', type: 'object', additionalProperties: true });

  await app.register(sectorRoutes);
  return app;
}

describe('auth sectors routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b1', companyId: 'c1' } } });
  });

  it('lists sectors with company scope and 403 without context', async () => {
    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    mockedPrisma.branch.findMany.mockResolvedValue([{ id: 'b1' }, { id: 'b2' }]);
    mockedPrisma.sector.findMany.mockResolvedValue([{ id: 's1' }]);

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/sectors' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/sectors' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: 's1' }]);

    await app.close();
  });

  it('creates sector with branch validation', async () => {
    mockedPrisma.branch.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'b1' });
    mockedPrisma.sector.create.mockResolvedValue({ id: 's1' });

    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/sectors', payload: { branchId: '', name: 'Recepção', description: 'x' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/sectors', payload: { branchId: 'b9', name: 'Recepção', description: 'x' } });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'POST', url: '/sectors', payload: { branchId: 'b1', name: 'Recepção', description: 'x' } });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('validates modalidade/especialidade/capacity on create', async () => {
    mockedPrisma.branch.findFirst.mockResolvedValue({ id: 'b1' });
    mockedPrisma.sector.create.mockResolvedValue({ id: 's1' });

    const app = await buildApp();

    mockedPrisma.especialidade.findUnique.mockResolvedValueOnce(null);
    let res = await app.inject({
      method: 'POST',
      url: '/sectors',
      payload: { branchId: 'b1', name: 'Sala 1', description: 'x', especialidadeId: 'e1' },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.especialidade.findUnique.mockResolvedValueOnce({ id: 'e1', modalidadeId: 'm-other' });
    res = await app.inject({
      method: 'POST',
      url: '/sectors',
      payload: { branchId: 'b1', name: 'Sala 1', description: 'x', modalidadeId: 'm1', especialidadeId: 'e1' },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/sectors',
      payload: { branchId: 'b1', name: 'Sala 1', description: 'x', capacity: 0 },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.especialidade.findUnique.mockResolvedValueOnce({ id: 'e1', modalidadeId: 'm1' });
    res = await app.inject({
      method: 'POST',
      url: '/sectors',
      payload: { branchId: 'b1', name: 'Sala 1', description: 'x', modalidadeId: 'm1', especialidadeId: 'e1', capacity: 3 },
    });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('gets sector by id with ownership checks', async () => {
    mockedPrisma.sector.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 's1', branch: { companyId: 'c2' } })
      .mockResolvedValueOnce({ id: 's1', branch: { companyId: 'c1' } });

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/sectors/s1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/sectors/s1' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/sectors/s1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('updates sector handling move rules and errors', async () => {
    mockedPrisma.sector.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 's1', branchId: 'b1', branch: { companyId: 'c2' } })
      .mockResolvedValueOnce({ id: 's1', branchId: 'b1', branch: { companyId: 'c1' } })
      .mockResolvedValueOnce({ id: 's1', branchId: 'b1', branch: { companyId: 'c1' } })
      .mockRejectedValueOnce(new Error('x'));
    mockedPrisma.branch.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'b2' });
    mockedPrisma.sector.update.mockResolvedValue({ id: 's1' });

    const app = await buildApp();

    let res = await app.inject({ method: 'PUT', url: '/sectors/s1', payload: { name: 'A' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/sectors/s1', payload: { name: 'A' } });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'PUT', url: '/sectors/s1', payload: { branchId: 'b9' } });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'PUT', url: '/sectors/s1', payload: { branchId: 'b2', name: 'B' } });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'PUT', url: '/sectors/s1', payload: { name: 'C' } });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('validates modalidade/especialidade/capacity on update', async () => {
    mockedPrisma.sector.findUnique.mockResolvedValue({ id: 's1', branchId: 'b1', modalidadeId: 'm1', branch: { companyId: 'c1' } });
    mockedPrisma.sector.update.mockResolvedValue({ id: 's1' });

    const app = await buildApp();

    mockedPrisma.especialidade.findUnique.mockResolvedValueOnce({ id: 'e1', modalidadeId: 'm-other' });
    let res = await app.inject({ method: 'PUT', url: '/sectors/s1', payload: { especialidadeId: 'e1' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PUT', url: '/sectors/s1', payload: { capacity: -1 } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.especialidade.findUnique.mockResolvedValueOnce({ id: 'e1', modalidadeId: 'm1' });
    res = await app.inject({ method: 'PUT', url: '/sectors/s1', payload: { especialidadeId: 'e1', capacity: 2 } });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'PUT', url: '/sectors/s1', payload: { especialidadeId: null, capacity: null } });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('deletes sector with ownership checks', async () => {
    mockedPrisma.sector.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 's1', branch: { companyId: 'c2' } })
      .mockResolvedValueOnce({ id: 's1', branch: { companyId: 'c1' } })
      .mockRejectedValueOnce(new Error('x'));
    mockedPrisma.sector.delete.mockResolvedValue({});

    const app = await buildApp();

    let res = await app.inject({ method: 'DELETE', url: '/sectors/s1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/sectors/s1' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'DELETE', url: '/sectors/s1' });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'DELETE', url: '/sectors/s1' });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});
