import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import cboRoutes from '../../src/modules/procedures/routes/cbos';
import prisma from '../../src/modules/procedures/lib/prisma';

vi.mock('../../src/modules/procedures/lib/prisma', () => ({
  default: {
    cbo: {
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

  await app.register(cboRoutes, { prefix: '/cbos' });
  return app;
}

describe('procedures cbos routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedPrisma.cbo.findMany.mockResolvedValue([{ id: 'cbo-1', title: 'Fisioterapeuta', code: '2236-05' }]);
    mockedPrisma.cbo.count.mockResolvedValue(1);
  });

  it('rejects unauthorized requests', async () => {
    const app = await buildApp({ unauthorized: true });
    const res = await app.inject({ method: 'GET', url: '/cbos' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('lists CBOs with default pagination', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/cbos' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [{ id: 'cbo-1', title: 'Fisioterapeuta', code: '2236-05' }], total: 1 });
    expect(mockedPrisma.cbo.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { isActive: true },
      take: 500,
      skip: 0,
    }));
    await app.close();
  });

  it('filters by search term across title and code', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/cbos?search=fisio&limit=10&offset=5' });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.cbo.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        isActive: true,
        OR: [
          { title: { contains: 'fisio', mode: 'insensitive' } },
          { code: { contains: 'fisio', mode: 'insensitive' } },
        ],
      },
      take: 10,
      skip: 5,
    }));
    await app.close();
  });
});
