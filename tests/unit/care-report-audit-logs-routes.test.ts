import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import reportAuditLogRoutes from '../../src/modules/care/routes/report-audit-logs';
import prisma from '../../src/modules/care/lib/prisma';

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    reportAuditLog: {
      findMany: vi.fn(),
      count: vi.fn(),
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

  await app.register(reportAuditLogRoutes, { prefix: '/report-audit-logs' });
  return app;
}

describe('care report-audit-logs routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b-1' } } });
    mockedPrisma.reportAuditLog.findMany.mockResolvedValue([{ id: 'l-1' }]);
    mockedPrisma.reportAuditLog.count.mockResolvedValue(1);
  });

  it('handles auth, branch check and required params', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/report-audit-logs?reportId=r-1' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    const app = await buildApp();
    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/report-audit-logs?reportId=r-1' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/report-audit-logs' });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'GET', url: '/report-audit-logs?reportId=r-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    res = await app.inject({ method: 'GET', url: '/report-audit-logs?addendumId=a-1&limit=5&offset=1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBe(1);

    await app.close();
  });
});
