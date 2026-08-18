import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import modalidadeRoutes from '../../src/modules/procedures/routes/modalidades';
import prisma from '../../src/modules/procedures/lib/prisma';

vi.mock('../../src/modules/procedures/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    modalidade: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    modalidadeAuditLog: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
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

  await app.register(modalidadeRoutes, { prefix: '/modalidades' });
  return app;
}

describe('procedures modalidades routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mockedPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', name: 'Lucas', sector: { branch: { id: 'b-1' } } });
    mockedPrisma.modalidade.findMany.mockResolvedValue([{ id: 'm-1', name: 'Tomografia', isActive: true }]);
    mockedPrisma.modalidade.count.mockResolvedValue(1);
    mockedPrisma.modalidade.findUnique.mockResolvedValue(null);
    mockedPrisma.modalidade.create.mockResolvedValue({ id: 'm-new', name: 'Ressonância' });
    mockedPrisma.modalidade.update.mockResolvedValue({ id: 'm-1', name: 'Tomografia' });
    mockedPrisma.modalidadeAuditLog.create.mockResolvedValue({ id: 'log-1' });
    mockedPrisma.modalidadeAuditLog.findMany.mockResolvedValue([{ id: 'log-1', action: 'CREATE' }]);
  });

  it('handles auth, list, get and audit log', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/modalidades' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    const app = await buildApp();

    mockedPrisma.user.findUnique.mockResolvedValueOnce({ sector: null });
    res = await app.inject({ method: 'GET', url: '/modalidades' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/modalidades?search=tomo&isActive=true' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    res = await app.inject({ method: 'GET', url: '/modalidades/m-1' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.modalidade.findUnique.mockResolvedValueOnce({ id: 'm-1', branchId: 'other' });
    res = await app.inject({ method: 'GET', url: '/modalidades/m-1' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.modalidade.findUnique.mockResolvedValueOnce({ id: 'm-1', branchId: 'b-1' });
    res = await app.inject({ method: 'GET', url: '/modalidades/m-1' });
    expect(res.statusCode).toBe(200);

    mockedPrisma.modalidade.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/modalidades/m-1/audit' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.modalidade.findUnique.mockResolvedValueOnce({ id: 'm-1', branchId: 'b-1' });
    res = await app.inject({ method: 'GET', url: '/modalidades/m-1/audit' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);

    await app.close();
  });

  it('creates modalidade, blocking exact duplicates and warning on similar names', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/modalidades', payload: { name: '' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.modalidade.findMany.mockResolvedValueOnce([{ id: 'm-1', name: 'Tomografia' }]);
    res = await app.inject({ method: 'POST', url: '/modalidades', payload: { name: 'tomografia' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('DUPLICATE_EXACT');

    mockedPrisma.modalidade.findMany.mockResolvedValueOnce([{ id: 'm-1', name: 'Tomografia' }]);
    res = await app.inject({ method: 'POST', url: '/modalidades', payload: { name: 'Tomogrfia' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('SIMILAR_EXISTS');

    mockedPrisma.modalidade.findMany.mockResolvedValueOnce([{ id: 'm-1', name: 'Tomografia' }]);
    res = await app.inject({ method: 'POST', url: '/modalidades', payload: { name: 'Tomogrfia', force: true } });
    expect(res.statusCode).toBe(201);

    mockedPrisma.modalidade.findMany.mockResolvedValueOnce([]);
    mockedPrisma.modalidade.create.mockRejectedValueOnce(new Error('boom'));
    res = await app.inject({ method: 'POST', url: '/modalidades', payload: { name: 'Ressonância' } });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('updates and deletes modalidade', async () => {
    const app = await buildApp();

    mockedPrisma.modalidade.findUnique.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'PUT', url: '/modalidades/m-1', payload: { name: 'X' } });
    expect(res.statusCode).toBe(404);

    mockedPrisma.modalidade.findUnique.mockResolvedValueOnce({ id: 'm-1', branchId: 'other', name: 'Tomografia' });
    res = await app.inject({ method: 'PUT', url: '/modalidades/m-1', payload: { name: 'X' } });
    expect(res.statusCode).toBe(404);

    mockedPrisma.modalidade.findUnique.mockResolvedValueOnce({ id: 'm-1', branchId: 'b-1', name: 'Tomografia' });
    res = await app.inject({ method: 'PUT', url: '/modalidades/m-1', payload: { name: '' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.modalidade.findUnique.mockResolvedValueOnce({ id: 'm-1', branchId: 'b-1', name: 'Tomografia' });
    mockedPrisma.modalidade.findMany.mockResolvedValueOnce([{ id: 'm-2', name: 'Ressonância' }]);
    res = await app.inject({ method: 'PUT', url: '/modalidades/m-1', payload: { name: 'ressonância' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('DUPLICATE_EXACT');

    mockedPrisma.modalidade.findUnique.mockResolvedValueOnce({ id: 'm-1', branchId: 'b-1', name: 'Tomografia' });
    mockedPrisma.modalidade.findMany.mockResolvedValueOnce([{ id: 'm-2', name: 'Ressonância' }]);
    res = await app.inject({ method: 'PUT', url: '/modalidades/m-1', payload: { name: 'Ressonanca' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('SIMILAR_EXISTS');

    mockedPrisma.modalidade.findUnique.mockResolvedValueOnce({ id: 'm-1', branchId: 'b-1', name: 'Tomografia', isActive: true });
    mockedPrisma.modalidade.findMany.mockResolvedValueOnce([]);
    mockedPrisma.modalidade.update.mockRejectedValueOnce(new Error('bad update'));
    res = await app.inject({ method: 'PUT', url: '/modalidades/m-1', payload: { name: 'Tomografia Computadorizada', isActive: false } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.modalidade.findUnique.mockResolvedValueOnce({ id: 'm-1', branchId: 'b-1', name: 'Tomografia', isActive: true });
    mockedPrisma.modalidade.findMany.mockResolvedValueOnce([]);
    res = await app.inject({ method: 'PUT', url: '/modalidades/m-1', payload: { name: 'Tomografia Computadorizada', isActive: false, force: true } });
    expect(res.statusCode).toBe(200);

    mockedPrisma.modalidade.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'DELETE', url: '/modalidades/m-1' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.modalidade.findUnique.mockResolvedValueOnce({ id: 'm-1', branchId: 'other', name: 'Tomografia' });
    res = await app.inject({ method: 'DELETE', url: '/modalidades/m-1' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.modalidade.findUnique.mockResolvedValueOnce({ id: 'm-1', branchId: 'b-1', name: 'Tomografia' });
    res = await app.inject({ method: 'DELETE', url: '/modalidades/m-1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });
});
