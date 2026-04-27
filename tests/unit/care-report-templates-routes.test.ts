import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import reportTemplateRoutes from '../../src/modules/care/routes/report-templates';
import prisma from '../../src/modules/care/lib/prisma';

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    reportTemplate: {
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

  await app.register(reportTemplateRoutes, { prefix: '/report-templates' });
  return app;
}

describe('care report-templates routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b-1' } } });
  });

  it('handles auth and list', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/report-templates' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    mockedPrisma.reportTemplate.findMany.mockResolvedValue([{ id: 't-1' }]);
    mockedPrisma.reportTemplate.count.mockResolvedValue(1);

    const app = await buildApp();
    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/report-templates' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/report-templates?search=tc&examType=TC' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    await app.close();
  });

  it('creates with validation and handles create error', async () => {
    mockedPrisma.reportTemplate.create.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ id: 't-1' });

    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/report-templates', payload: { examType: 'TC', content: 'x' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/report-templates', payload: { name: 'Modelo', content: 'x' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/report-templates', payload: { name: 'Modelo', examType: 'TC' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/report-templates', payload: { name: 'Modelo', examType: 'TC', content: 'x' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/report-templates', payload: { name: 'Modelo', examType: 'TC', content: 'x' } });
    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it('updates and deletes', async () => {
    mockedPrisma.reportTemplate.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 't-1' })
      .mockResolvedValueOnce({ id: 't-1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 't-1' });
    mockedPrisma.reportTemplate.update.mockRejectedValueOnce(new Error('bad update')).mockResolvedValueOnce({ id: 't-1' });
    mockedPrisma.reportTemplate.delete.mockResolvedValue({});

    const app = await buildApp();

    let res = await app.inject({ method: 'PUT', url: '/report-templates/t-1', payload: { name: 'x' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/report-templates/t-1', payload: { name: 'x' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PUT', url: '/report-templates/t-1', payload: { name: 'y' } });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'DELETE', url: '/report-templates/t-1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/report-templates/t-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'Deleted' });

    await app.close();
  });
});
