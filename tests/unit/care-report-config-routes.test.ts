import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import reportConfigRoutes from '../../src/modules/care/routes/report-config';
import prisma from '../../src/modules/care/lib/prisma';

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    reportConfig: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
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

  await app.register(reportConfigRoutes, { prefix: '/report-config' });
  return app;
}

describe('care report-config routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b-1' } } });
  });

  it('handles auth and get config', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/report-config' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    const app = await buildApp();
    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/report-config' });
    expect(res.statusCode).toBe(403);

    mockedPrisma.reportConfig.findFirst.mockResolvedValueOnce({ id: 'c-1', branchId: 'b-1', requiresReviewer: true });
    res = await app.inject({ method: 'GET', url: '/report-config' });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('c-1');

    mockedPrisma.reportConfig.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.reportConfig.create.mockResolvedValueOnce({ id: 'c-2', branchId: 'b-1', requiresReviewer: true });
    res = await app.inject({ method: 'GET', url: '/report-config' });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('c-2');

    await app.close();
  });

  it('updates config with validation', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'PUT', url: '/report-config', payload: { requiresReviewer: 'yes' } });
    expect(res.statusCode).toBe(400);

    // reportLayout must be an object (not string/null/array)
    res = await app.inject({ method: 'PUT', url: '/report-config', payload: { reportLayout: 'invalid' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PUT', url: '/report-config', payload: { reportLayout: ['a', 'b'] } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.reportConfig.findFirst.mockResolvedValueOnce({ id: 'c-1', branchId: 'b-1', requiresReviewer: true });
    mockedPrisma.reportConfig.update.mockResolvedValueOnce({ id: 'c-1', branchId: 'b-1', requiresReviewer: false });
    res = await app.inject({ method: 'PUT', url: '/report-config', payload: { requiresReviewer: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json().requiresReviewer).toBe(false);

    mockedPrisma.reportConfig.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.reportConfig.create.mockResolvedValueOnce({ id: 'c-2', branchId: 'b-1', requiresReviewer: true });
    mockedPrisma.reportConfig.update.mockResolvedValueOnce({ id: 'c-2', branchId: 'b-1', requiresReviewer: true });
    res = await app.inject({ method: 'PUT', url: '/report-config', payload: { requiresReviewer: true } });
    expect(res.statusCode).toBe(200);

    await app.close();
  });
});
