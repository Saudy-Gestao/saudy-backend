import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mwlRoutes from '../../src/modules/care/routes/mwl';
import prisma from '../../src/modules/care/lib/prisma';

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    mwlEntry: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

const mockedPrisma = prisma as any;
const originalToken = process.env.MWL_PUBLIC_TOKEN;

async function buildApp(opts?: { unauthorized?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1' };
  });

  await app.register(mwlRoutes, { prefix: '/mwl' });
  return app;
}

describe('care mwl routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.MWL_PUBLIC_TOKEN = 'public-secret';
    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b-1' } } });
  });

  afterEach(() => {
    process.env.MWL_PUBLIC_TOKEN = originalToken;
  });

  it('enforces auth for private routes and token for public feed', async () => {
    const privateApp = await buildApp({ unauthorized: true });
    let res = await privateApp.inject({ method: 'GET', url: '/mwl' });
    expect(res.statusCode).toBe(401);
    await privateApp.close();

    const app = await buildApp();
    mockedPrisma.mwlEntry.findMany.mockResolvedValue([]);
    res = await app.inject({ method: 'GET', url: '/mwl/public-feed?branchId=b-1' });
    expect(res.statusCode).toBe(401);

    res = await app.inject({
      method: 'GET',
      url: '/mwl/public-feed?branchId=b-1',
      headers: { 'x-mwl-token': 'public-secret' },
    });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('lists public feed and private list with branch checks', async () => {
    mockedPrisma.mwlEntry.findMany.mockResolvedValue([
      {
        id: 'm1',
        accessionNumber: 'ACC-1',
        patientName: 'Maria',
        patientCpf: '123',
        examType: 'TC',
        scheduledAt: '2026-04-13T10:00:00',
        requestingDoctor: 'Dr X',
        appointmentId: 'a1',
        status: 'agendado',
        appointment: { id: 'a1', patientName: 'Maria', patientCpf: '123', doctorName: 'Dr X', specialty: 'TC' },
      },
    ]);
    mockedPrisma.mwlEntry.count.mockResolvedValue(1);

    const app = await buildApp();

    let res = await app.inject({
      method: 'GET',
      url: '/mwl/public-feed?branchId=b-1&token=public-secret&status=agendado&date=2026-04-13',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/mwl' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/mwl?search=maria&status=agendado&date=2026-04-13' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBe(1);

    await app.close();
  });

  it('gets and updates mwl entries', async () => {
    mockedPrisma.mwlEntry.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'm1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'm1' });
    mockedPrisma.mwlEntry.update.mockResolvedValue({ id: 'm1', accessionNumber: 'ACC-2' });

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/mwl/m1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/mwl/m1' });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'PUT', url: '/mwl/m1', payload: { accessionNumber: 'ACC-2' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/mwl/m1', payload: { accessionNumber: 'ACC-2' } });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('denies public feed when token is not configured on server startup', async () => {
    process.env.MWL_PUBLIC_TOKEN = '';
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/mwl/public-feed?branchId=b-1&token=public-secret',
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('supports token query auth and maps fallback fields in public feed', async () => {
    mockedPrisma.mwlEntry.findMany.mockResolvedValueOnce([
      {
        id: 'm2',
        accessionNumber: null,
        patientName: 'Ana',
        patientCpf: '999',
        examType: null,
        scheduledAt: null,
        requestingDoctor: 'Dr Y',
        appointmentId: null,
        status: null,
        appointment: null,
      },
    ]);

    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/mwl/public-feed?branchId=b-1&token=public-secret&limit=1000',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toEqual(
      expect.objectContaining({
        patientName: 'Ana',
        patientId: '999',
        examType: null,
        status: 'agendado',
      }),
    );
    expect(mockedPrisma.mwlEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 500,
      }),
    );

    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    const privateRes = await app.inject({
      method: 'PUT',
      url: '/mwl/m1',
      payload: { accessionNumber: 'ACC-9' },
    });
    expect(privateRes.statusCode).toBe(403);

    await app.close();
  });
});
