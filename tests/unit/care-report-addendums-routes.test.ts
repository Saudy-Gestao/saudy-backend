import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import reportAddendumRoutes from '../../src/modules/care/routes/report-addendums';
import prisma from '../../src/modules/care/lib/prisma';

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    reportAddendum: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    reportWorklistItem: { findFirst: vi.fn() },
    report: { findFirst: vi.fn() },
    reportAuditLog: { create: vi.fn() },
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

  await app.register(reportAddendumRoutes, { prefix: '/report-addendums' });
  return app;
}

describe('care report-addendums routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 'u-1',
      name: 'User',
      sector: { branch: { id: 'b-1' } },
    });
    mockedPrisma.reportAddendum.findMany.mockResolvedValue([{ id: 'a-1' }]);
    mockedPrisma.reportAddendum.count.mockResolvedValue(1);
    mockedPrisma.reportAddendum.findFirst.mockResolvedValue(null);
    mockedPrisma.reportAddendum.create.mockResolvedValue({ id: 'a-1', status: 'draft' });
    mockedPrisma.reportAddendum.update.mockResolvedValue({ id: 'a-1', status: 'finalizado' });
    mockedPrisma.reportAddendum.delete.mockResolvedValue({});
    mockedPrisma.reportWorklistItem.findFirst.mockResolvedValue({ id: 'w-1' });
    mockedPrisma.report.findFirst.mockResolvedValue({ id: 'r-1' });
    mockedPrisma.reportAuditLog.create.mockResolvedValue({});
  });

  it('handles auth and listing rules', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/report-addendums?reportId=r-1' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    const app = await buildApp();
    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/report-addendums?reportId=r-1' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/report-addendums' });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'GET', url: '/report-addendums?reportId=r-1&status=draft' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    await app.close();
  });

  it('creates addendum with validation and not found checks', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/report-addendums', payload: {} });
    expect(res.statusCode).toBe(400);

    mockedPrisma.reportWorklistItem.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'POST', url: '/report-addendums', payload: { worklistItemId: 'w-1' } });
    expect(res.statusCode).toBe(404);

    mockedPrisma.report.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'POST', url: '/report-addendums', payload: { reportId: 'r-1' } });
    expect(res.statusCode).toBe(404);

    mockedPrisma.reportAddendum.create.mockRejectedValueOnce(new Error('bad create'));
    res = await app.inject({ method: 'POST', url: '/report-addendums', payload: { reportId: 'r-1' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/report-addendums', payload: { reportId: 'r-1', content: 'abc' } });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('updates and deletes addendum', async () => {
    const app = await buildApp();

    mockedPrisma.reportAddendum.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'a-1', reportId: 'r-1', status: 'draft', content: '' })
      .mockResolvedValueOnce({ id: 'a-1', reportId: 'r-1', status: 'draft', content: '' })
      .mockResolvedValueOnce({ id: 'a-1', reportId: 'r-1', status: 'draft', content: '' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'a-1', reportId: 'r-1', status: 'finalizado', content: 'x' });

    mockedPrisma.reportAddendum.update.mockRejectedValueOnce(new Error('bad update')).mockResolvedValue({ id: 'a-1' });

    let res = await app.inject({ method: 'PUT', url: '/report-addendums/a-1', payload: { status: 'finalizado' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/report-addendums/a-1', payload: { status: 'finalizado' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PUT', url: '/report-addendums/a-1', payload: { status: 'finalizado' } });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'DELETE', url: '/report-addendums/a-1' });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'DELETE', url: '/report-addendums/a-1' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
