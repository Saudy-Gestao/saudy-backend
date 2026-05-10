import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import knowledgeSuggestionsRoutes from '../../src/modules/admin/routes/knowledge-suggestions';
import prismaModule from '../../src/lib/prisma';

vi.mock('../../src/lib/prisma', () => ({
  default: {
    knowledgeSuggestion: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

const prisma = (prismaModule as any);

async function buildApp(role = 'ADMIN') {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function (this: any) {
    this.user = { id: 'u-1', role };
  });
  await app.register(knowledgeSuggestionsRoutes, { prefix: '/knowledge-suggestions' });
  return app;
}

describe('admin knowledge-suggestions routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects unauthenticated and non-admin roles', async () => {
    const appUser = await buildApp('USER');
    const res = await appUser.inject({ method: 'GET', url: '/knowledge-suggestions' });
    expect(res.statusCode).toBe(403);
    await appUser.close();
  });

  it('lists all suggestions without filter', async () => {
    prisma.knowledgeSuggestion.findMany.mockResolvedValue([{ id: 's1', status: 'pending' }]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/knowledge-suggestions' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: 's1', status: 'pending' }]);
    expect(prisma.knowledgeSuggestion.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
    await app.close();
  });

  it('lists suggestions filtered by valid status', async () => {
    prisma.knowledgeSuggestion.findMany.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/knowledge-suggestions?status=approved' });
    expect(res.statusCode).toBe(200);
    expect(prisma.knowledgeSuggestion.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'approved' } }));
    await app.close();
  });

  it('ignores invalid status filter and returns all', async () => {
    prisma.knowledgeSuggestion.findMany.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/knowledge-suggestions?status=invalid' });
    expect(res.statusCode).toBe(200);
    expect(prisma.knowledgeSuggestion.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
    await app.close();
  });

  it('gets suggestion by id and returns 404 when not found', async () => {
    prisma.knowledgeSuggestion.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 's1' });
    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/knowledge-suggestions/s1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/knowledge-suggestions/s1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 's1' });
    await app.close();
  });

  it('patches suggestion status and optionally updates answer', async () => {
    prisma.knowledgeSuggestion.findUnique.mockResolvedValue({ id: 's1' });
    prisma.knowledgeSuggestion.update.mockResolvedValue({ id: 's1', status: 'approved', answer: 'nova resposta' });
    const app = await buildApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/knowledge-suggestions/s1',
      payload: { status: 'approved', answer: 'nova resposta' },
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.knowledgeSuggestion.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'approved', answer: 'nova resposta' }),
    }));
    await app.close();
  });

  it('patches suggestion without answer does not update it', async () => {
    prisma.knowledgeSuggestion.findUnique.mockResolvedValue({ id: 's1' });
    prisma.knowledgeSuggestion.update.mockResolvedValue({ id: 's1', status: 'rejected' });
    const app = await buildApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/knowledge-suggestions/s1',
      payload: { status: 'rejected' },
    });
    expect(res.statusCode).toBe(200);
    const callData = prisma.knowledgeSuggestion.update.mock.calls[0][0].data;
    expect(callData).not.toHaveProperty('answer');
    await app.close();
  });

  it('returns 400 for invalid status on patch', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/knowledge-suggestions/s1',
      payload: { status: 'invalid' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 404 on patch when suggestion not found', async () => {
    prisma.knowledgeSuggestion.findUnique.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/knowledge-suggestions/s1',
      payload: { status: 'approved' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('deletes suggestion and returns 404 when not found', async () => {
    prisma.knowledgeSuggestion.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 's1' });
    prisma.knowledgeSuggestion.delete.mockResolvedValue({ id: 's1' });
    const app = await buildApp('SUPERADMIN');

    let res = await app.inject({ method: 'DELETE', url: '/knowledge-suggestions/s1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/knowledge-suggestions/s1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});
