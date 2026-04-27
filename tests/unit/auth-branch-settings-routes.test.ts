import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import branchSettingsRoutes from '../../src/modules/auth/routes/branch-settings';
import prisma from '../../src/lib/prisma';

vi.mock('../../src/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    branch: { findUnique: vi.fn() },
    branchSettings: {
      findUnique: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
    },
    branchPublicCheckInAuditLog: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

const mockedPrisma = prisma as any;

const tx = {
  branchSettings: { upsert: vi.fn() },
  branchPublicCheckInAuditLog: { create: vi.fn() },
};

async function buildApp(opts?: { unauthorized?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1' };
  });

  await app.register(branchSettingsRoutes);
  return app;
}

describe('auth branch settings routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 'u-1',
      name: 'User Test',
      email: 'user@test.com',
      sector: { branch: { id: 'b-1', companyId: 'c-1' } },
    });
    mockedPrisma.branch.findUnique.mockResolvedValue({ id: 'b-1', companyId: 'c-1' });

    mockedPrisma.branchSettings.findUnique.mockResolvedValue({ branchId: 'b-1', publicCheckInEnabled: false });
    mockedPrisma.branchSettings.create.mockResolvedValue({ branchId: 'b-1', publicCheckInEnabled: false });
    mockedPrisma.branchPublicCheckInAuditLog.findMany.mockResolvedValue([]);

    tx.branchSettings.upsert.mockResolvedValue({ branchId: 'b-1' });
    tx.branchPublicCheckInAuditLog.create.mockResolvedValue({ id: 'log-1' });
    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));
  });

  it('enforces auth and get branch access checks', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/branches/b-1/settings' });
    expect(res.statusCode).toBe(500);
    await unauth.close();

    const app = await buildApp();

    mockedPrisma.user.findUnique.mockResolvedValueOnce({ id: 'u-1', sector: { branch: { id: 'b-1', companyId: null } } });
    res = await app.inject({ method: 'GET', url: '/branches/b-1/settings' });
    expect(res.statusCode).toBe(403);

    mockedPrisma.branch.findUnique.mockResolvedValueOnce({ id: 'b-2', companyId: 'c-2' });
    res = await app.inject({ method: 'GET', url: '/branches/b-2/settings' });
    expect(res.statusCode).toBe(403);

    mockedPrisma.branchSettings.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ branchId: 'b-1', publicCheckInEnabled: false });
    res = await app.inject({ method: 'GET', url: '/branches/b-1/settings' });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.branchSettings.create).toHaveBeenCalled();

    await app.close();
  });

  it('updates settings and writes audit when toggling public check-in', async () => {
    const app = await buildApp();

    mockedPrisma.branchSettings.findUnique
      .mockResolvedValueOnce({ branchId: 'b-1', publicCheckInEnabled: false })
      .mockResolvedValueOnce({ branchId: 'b-1', publicCheckInEnabled: true });

    const res = await app.inject({
      method: 'PUT',
      url: '/branches/b-1/settings',
      payload: {
        requireFacialForReportDelivery: true,
        requireFacialForPatientRegistration: true,
        noShowToleranceMinutes: -7,
        publicCheckInEnabled: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(tx.branchSettings.upsert).toHaveBeenCalled();
    expect(tx.branchPublicCheckInAuditLog.create).toHaveBeenCalled();

    await app.close();
  });

  it('updates settings and writes DISABLED audit metadata when turning public check-in off', async () => {
    const app = await buildApp();

    mockedPrisma.branchSettings.findUnique
      .mockResolvedValueOnce({ branchId: 'b-1', publicCheckInEnabled: true })
      .mockResolvedValueOnce({ branchId: 'b-1', publicCheckInEnabled: false });

    const res = await app.inject({
      method: 'PUT',
      url: '/branches/b-1/settings',
      payload: {
        publicCheckInEnabled: false,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(tx.branchSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        publicCheckInEnabled: false,
        publicCheckInLastDisabledAt: expect.any(Date),
        publicCheckInLastDisabledByUserId: 'u-1',
      }),
      create: expect.objectContaining({
        publicCheckInEnabled: false,
        publicCheckInLastDisabledAt: expect.any(Date),
        publicCheckInLastDisabledByUserId: 'u-1',
      }),
    }));
    expect(tx.branchPublicCheckInAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'DISABLED' }),
    }));

    await app.close();
  });

  it('denies update for non-company user/branch mismatch', async () => {
    const app = await buildApp();

    mockedPrisma.user.findUnique.mockResolvedValueOnce({ id: 'u-1', sector: { branch: { id: 'b-1', companyId: null } } });
    let res = await app.inject({ method: 'PUT', url: '/branches/b-1/settings', payload: {} });
    expect(res.statusCode).toBe(403);

    mockedPrisma.branch.findUnique.mockResolvedValueOnce({ id: 'b-2', companyId: 'c-2' });
    res = await app.inject({ method: 'PUT', url: '/branches/b-2/settings', payload: {} });
    expect(res.statusCode).toBe(403);

    await app.close();
  });
});
