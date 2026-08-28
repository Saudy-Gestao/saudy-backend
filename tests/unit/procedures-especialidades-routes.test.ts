import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import especialidadeRoutes from '../../src/modules/procedures/routes/especialidades';
import prisma from '../../src/modules/procedures/lib/prisma';

vi.mock('../../src/modules/procedures/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    modalidade: {
      findUnique: vi.fn(),
    },
    cbo: {
      findUnique: vi.fn(),
    },
    especialidade: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    especialidadeAuditLog: {
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

  await app.register(especialidadeRoutes, { prefix: '/especialidades' });
  return app;
}

describe('procedures especialidades routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mockedPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', name: 'Lucas', sector: { branch: { id: 'b-1' } } });
    mockedPrisma.modalidade.findUnique.mockResolvedValue({ id: 'm-1', branchId: 'b-1', name: 'Tomografia' });
    mockedPrisma.especialidade.findMany.mockResolvedValue([{ id: 'e-1', name: 'TC Crânio', modalidadeId: 'm-1' }]);
    mockedPrisma.especialidade.count.mockResolvedValue(1);
    mockedPrisma.especialidade.findUnique.mockResolvedValue(null);
    mockedPrisma.especialidade.create.mockResolvedValue({ id: 'e-new', name: 'TC Tórax' });
    mockedPrisma.especialidade.update.mockResolvedValue({ id: 'e-1', name: 'TC Crânio' });
    mockedPrisma.especialidadeAuditLog.create.mockResolvedValue({ id: 'log-1' });
    mockedPrisma.especialidadeAuditLog.findMany.mockResolvedValue([{ id: 'log-1', action: 'CREATE' }]);
  });

  it('handles auth, list, get and audit log', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/especialidades' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    const app = await buildApp();

    mockedPrisma.user.findUnique.mockResolvedValueOnce({ sector: null });
    res = await app.inject({ method: 'GET', url: '/especialidades' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/especialidades?modalidadeId=m-1&search=crânio&isActive=true' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    res = await app.inject({ method: 'GET', url: '/especialidades/e-1' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.especialidade.findUnique.mockResolvedValueOnce({ id: 'e-1', branchId: 'other' });
    res = await app.inject({ method: 'GET', url: '/especialidades/e-1' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.especialidade.findUnique.mockResolvedValueOnce({ id: 'e-1', branchId: 'b-1' });
    res = await app.inject({ method: 'GET', url: '/especialidades/e-1' });
    expect(res.statusCode).toBe(200);

    mockedPrisma.especialidade.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/especialidades/e-1/audit' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.especialidade.findUnique.mockResolvedValueOnce({ id: 'e-1', branchId: 'b-1' });
    res = await app.inject({ method: 'GET', url: '/especialidades/e-1/audit' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);

    await app.close();
  });

  it('creates especialidade, validating modalidade and blocking duplicate/similar names', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/especialidades', payload: { modalidadeId: 'm-1', name: '' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.modalidade.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'POST', url: '/especialidades', payload: { modalidadeId: 'm-x', name: 'TC Tórax' } });
    expect(res.statusCode).toBe(404);

    mockedPrisma.modalidade.findUnique.mockResolvedValueOnce({ id: 'm-1', branchId: 'other' });
    res = await app.inject({ method: 'POST', url: '/especialidades', payload: { modalidadeId: 'm-1', name: 'TC Tórax' } });
    expect(res.statusCode).toBe(404);

    mockedPrisma.especialidade.findMany.mockResolvedValueOnce([{ id: 'e-1', name: 'TC Crânio' }]);
    res = await app.inject({ method: 'POST', url: '/especialidades', payload: { modalidadeId: 'm-1', name: 'tc crânio' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('DUPLICATE_EXACT');

    mockedPrisma.especialidade.findMany.mockResolvedValueOnce([]);
    res = await app.inject({
      method: 'POST',
      url: '/especialidades',
      payload: { modalidadeId: 'm-1', name: 'TC Tórax' },
    });
    expect(res.statusCode).toBe(201);

    mockedPrisma.especialidade.findMany.mockResolvedValueOnce([]);
    mockedPrisma.especialidade.create.mockRejectedValueOnce(new Error('boom'));
    res = await app.inject({ method: 'POST', url: '/especialidades', payload: { modalidadeId: 'm-1', name: 'TC Abdômen' } });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('updates and deletes especialidade', async () => {
    const app = await buildApp();

    mockedPrisma.especialidade.findUnique.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'PUT', url: '/especialidades/e-1', payload: { name: 'X' } });
    expect(res.statusCode).toBe(404);

    mockedPrisma.especialidade.findUnique.mockResolvedValueOnce({ id: 'e-1', branchId: 'other', name: 'TC Crânio', modalidadeId: 'm-1' });
    res = await app.inject({ method: 'PUT', url: '/especialidades/e-1', payload: { name: 'X' } });
    expect(res.statusCode).toBe(404);

    mockedPrisma.especialidade.findUnique.mockResolvedValueOnce({ id: 'e-1', branchId: 'b-1', name: 'TC Crânio', modalidadeId: 'm-1' });
    res = await app.inject({ method: 'PUT', url: '/especialidades/e-1', payload: { name: '' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.especialidade.findUnique.mockResolvedValueOnce({ id: 'e-1', branchId: 'b-1', name: 'TC Crânio', modalidadeId: 'm-1' });
    mockedPrisma.especialidade.findMany.mockResolvedValueOnce([{ id: 'e-2', name: 'TC Tórax' }]);
    res = await app.inject({ method: 'PUT', url: '/especialidades/e-1', payload: { name: 'tc tórax' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('DUPLICATE_EXACT');

    mockedPrisma.especialidade.findUnique.mockResolvedValueOnce({ id: 'e-1', branchId: 'b-1', name: 'TC Crânio', modalidadeId: 'm-1' });
    mockedPrisma.especialidade.findMany.mockResolvedValueOnce([{ id: 'e-2', name: 'TC Tórax' }]);
    res = await app.inject({ method: 'PUT', url: '/especialidades/e-1', payload: { name: 'TC Trax' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('SIMILAR_EXISTS');

    mockedPrisma.especialidade.findUnique.mockResolvedValueOnce({
      id: 'e-1', branchId: 'b-1', name: 'TC Crânio', modalidadeId: 'm-1', isActive: true, metodos: ['Com contraste'],
    });
    mockedPrisma.especialidade.findMany.mockResolvedValueOnce([]);
    mockedPrisma.especialidade.update.mockRejectedValueOnce(new Error('bad update'));
    res = await app.inject({
      method: 'PUT',
      url: '/especialidades/e-1',
      payload: { name: 'TC Crânio Simples', metodos: ['Sem contraste'], isActive: false },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.especialidade.findUnique.mockResolvedValueOnce({
      id: 'e-1', branchId: 'b-1', name: 'TC Crânio', modalidadeId: 'm-1', isActive: true, metodos: ['Com contraste'],
    });
    mockedPrisma.especialidade.findMany.mockResolvedValueOnce([]);
    res = await app.inject({
      method: 'PUT',
      url: '/especialidades/e-1',
      payload: { name: 'TC Crânio Simples', metodos: ['Sem contraste'], isActive: false, force: true },
    });
    expect(res.statusCode).toBe(200);

    mockedPrisma.especialidade.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'DELETE', url: '/especialidades/e-1' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.especialidade.findUnique.mockResolvedValueOnce({ id: 'e-1', branchId: 'other', name: 'TC Crânio' });
    res = await app.inject({ method: 'DELETE', url: '/especialidades/e-1' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.especialidade.findUnique.mockResolvedValueOnce({ id: 'e-1', branchId: 'b-1', name: 'TC Crânio' });
    res = await app.inject({ method: 'DELETE', url: '/especialidades/e-1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });
});
