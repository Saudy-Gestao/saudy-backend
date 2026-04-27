import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import moduleRoutes from '../../src/modules/auth/routes/modules';
import prisma from '../../src/modules/auth/lib/prisma';
import * as moduleTypeAccess from '../../src/modules/auth/lib/module-type-access';

vi.mock('../../src/modules/auth/lib/prisma', () => ({
  default: {
    module: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../src/modules/auth/lib/module-type-access', async () => {
  const actual = await vi.importActual<typeof import('../../src/modules/auth/lib/module-type-access')>(
    '../../src/modules/auth/lib/module-type-access',
  );
  return {
    ...actual,
    getRequestCompanyModuleType: vi.fn(),
    filterModulesForCompanyType: vi.fn(),
  };
});

const mockedPrisma = prisma as any;
const mockedGetRequestCompanyModuleType = moduleTypeAccess.getRequestCompanyModuleType as any;
const mockedFilterModulesForCompanyType = moduleTypeAccess.filterModulesForCompanyType as any;

describe('auth module routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function buildApp() {
    const app = Fastify();
    app.decorateRequest('user', null);
    app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
      this.user = { id: 'user-1' };
    });

    await app.register(moduleRoutes);
    return app;
  }

  it('returns 403 when user is not associated with a company', async () => {
    mockedGetRequestCompanyModuleType.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/modules' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'User not associated with a company' });

    await app.close();
  });

  it('lists filtered modules for company module type', async () => {
    mockedGetRequestCompanyModuleType.mockResolvedValue('apenas-tea');
    mockedPrisma.module.findMany.mockResolvedValue([
      { id: '1', name: 'modulo-tea' },
      { id: '2', name: 'financeiro' },
    ]);
    mockedFilterModulesForCompanyType.mockReturnValue([{ id: '1', name: 'modulo-tea' }]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/modules' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: '1', name: 'modulo-tea' }]);
    expect(mockedPrisma.module.findMany).toHaveBeenCalled();
    expect(mockedFilterModulesForCompanyType).toHaveBeenCalledWith(
      expect.any(Array),
      'apenas-tea',
    );

    await app.close();
  });

  it('returns module by id and 404 when not found', async () => {
    mockedPrisma.module.findUnique
      .mockResolvedValueOnce({ id: 'module-1', name: 'modulo-tea' })
      .mockResolvedValueOnce(null);

    const app = await buildApp();

    const ok = await app.inject({ method: 'GET', url: '/modules/module-1' });
    expect(ok.statusCode).toBe(200);
    expect(mockedPrisma.module.findUnique).toHaveBeenCalledWith({
      where: { id: 'module-1' },
    });

    const notFound = await app.inject({ method: 'GET', url: '/modules/module-2' });
    expect(notFound.statusCode).toBe(404);
    expect(mockedPrisma.module.findUnique).toHaveBeenCalledTimes(2);

    await app.close();
  });
});
