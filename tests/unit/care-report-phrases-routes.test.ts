import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import reportPhraseRoutes from '../../src/modules/care/routes/report-phrases';
import prisma from '../../src/modules/care/lib/prisma';

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    reportPhrase: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
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

  await app.register(reportPhraseRoutes, { prefix: '/report-phrases' });
  return app;
}

describe('care report-phrases routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b-1' } } });
  });

  it('handles auth and list', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/report-phrases' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    mockedPrisma.reportPhrase.findMany.mockResolvedValue([{ id: 'p-1' }]);
    mockedPrisma.reportPhrase.count.mockResolvedValue(1);

    const app = await buildApp();
    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/report-phrases' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/report-phrases?search=normal&examType=RX' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    await app.close();
  });

  it('creates with validation and handles create error', async () => {
    mockedPrisma.reportPhrase.create.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ id: 'p-1' });

    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/report-phrases', payload: { examType: 'RX', text: 'x' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/report-phrases', payload: { label: 'Frase', text: 'x' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/report-phrases', payload: { label: 'Frase', examType: 'RX' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/report-phrases', payload: { label: 'Frase', examType: 'RX', text: 'x' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/report-phrases', payload: { label: 'Frase', examType: 'RX', text: 'x' } });
    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it('updates and deletes', async () => {
    mockedPrisma.reportPhrase.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'p-1' })
      .mockResolvedValueOnce({ id: 'p-1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'p-1' });
    mockedPrisma.reportPhrase.update.mockRejectedValueOnce(new Error('bad update')).mockResolvedValueOnce({ id: 'p-1' });
    mockedPrisma.reportPhrase.delete.mockResolvedValue({});

    const app = await buildApp();

    let res = await app.inject({ method: 'PUT', url: '/report-phrases/p-1', payload: { label: 'x' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/report-phrases/p-1', payload: { label: 'x' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PUT', url: '/report-phrases/p-1', payload: { label: 'y' } });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'DELETE', url: '/report-phrases/p-1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/report-phrases/p-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'Deleted' });

    await app.close();
  });
});
