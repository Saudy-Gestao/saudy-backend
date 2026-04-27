import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import accessRoutes from '../../src/modules/auth/routes/accesses';
import prisma from '../../src/modules/auth/lib/prisma';
import * as moduleTypeAccess from '../../src/modules/auth/lib/module-type-access';

vi.mock('../../src/modules/auth/lib/prisma', () => ({
  default: {
    access: {
      findMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    module: {
      findMany: vi.fn(),
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

async function buildApp() {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    this.user = { id: 'u-1' };
  });

  app.addSchema({ $id: 'AccessCreate', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'Access', type: 'object', additionalProperties: true });

  await app.register(accessRoutes);
  return app;
}

describe('auth accesses routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('lists accesses', async () => {
    mockedPrisma.access.findMany.mockResolvedValue([{ id: 'a-1' }]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/accesses' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: 'a-1' }]);
    await app.close();
  });

  it('creates access with validation and module-type checks', async () => {
    mockedGetRequestCompanyModuleType.mockResolvedValue('apenas-tea');
    mockedPrisma.module.findMany.mockResolvedValue([{ id: 'm-1' }, { id: 'm-2' }]);
    mockedFilterModulesForCompanyType.mockReturnValue([{ id: 'm-1' }]);
    mockedPrisma.access.create.mockResolvedValue({ id: 'a-1' });

    const app = await buildApp();

    let res = await app.inject({
      method: 'POST',
      url: '/accesses',
      payload: { description: 'Admin', moduleIds: [] },
    });
    expect(res.statusCode).toBe(400);

    mockedGetRequestCompanyModuleType.mockResolvedValueOnce(null);
    res = await app.inject({
      method: 'POST',
      url: '/accesses',
      payload: { description: 'Admin', moduleIds: ['m-1'] },
    });
    expect(res.statusCode).toBe(403);

    mockedGetRequestCompanyModuleType.mockResolvedValueOnce('apenas-tea');
    res = await app.inject({
      method: 'POST',
      url: '/accesses',
      payload: { description: 'Admin', moduleIds: ['m-2'] },
    });
    expect(res.statusCode).toBe(400);

    mockedFilterModulesForCompanyType.mockReturnValueOnce([{ id: 'm-1' }]);
    res = await app.inject({
      method: 'POST',
      url: '/accesses',
      payload: { description: 'Admin', moduleIds: ['m-1'] },
    });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('gets access by id and handles not found', async () => {
    mockedPrisma.access.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'a-1' });

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/accesses/a-1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/accesses/a-1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('updates access with validations and handles failures', async () => {
    mockedGetRequestCompanyModuleType.mockResolvedValue('padrao');
    mockedPrisma.module.findMany.mockResolvedValue([{ id: 'm-1' }]);
    mockedFilterModulesForCompanyType.mockReturnValue([{ id: 'm-1' }]);
    mockedPrisma.access.update
      .mockResolvedValueOnce({ id: 'a-1' })
      .mockRejectedValueOnce(new Error('not-found'));

    const app = await buildApp();

    let res = await app.inject({
      method: 'PUT',
      url: '/accesses/a-1',
      payload: { moduleIds: [] },
    });
    expect(res.statusCode).toBe(400);

    mockedGetRequestCompanyModuleType.mockResolvedValueOnce(null);
    res = await app.inject({
      method: 'PUT',
      url: '/accesses/a-1',
      payload: { description: 'x' },
    });
    expect(res.statusCode).toBe(403);

    mockedGetRequestCompanyModuleType.mockResolvedValueOnce('padrao');
    mockedFilterModulesForCompanyType.mockReturnValueOnce([]);
    res = await app.inject({
      method: 'PUT',
      url: '/accesses/a-1',
      payload: { moduleIds: ['m-1'] },
    });
    expect(res.statusCode).toBe(400);

    mockedGetRequestCompanyModuleType.mockResolvedValueOnce('padrao');
    mockedFilterModulesForCompanyType.mockReturnValueOnce([{ id: 'm-1' }]);
    res = await app.inject({
      method: 'PUT',
      url: '/accesses/a-1',
      payload: { description: 'new', moduleIds: ['m-1'] },
    });
    expect(res.statusCode).toBe(200);

    mockedGetRequestCompanyModuleType.mockResolvedValueOnce('padrao');
    res = await app.inject({
      method: 'PUT',
      url: '/accesses/a-1',
      payload: { description: 'another' },
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('deletes access and handles not found', async () => {
    mockedPrisma.access.delete.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('x'));

    const app = await buildApp();

    let res = await app.inject({ method: 'DELETE', url: '/accesses/a-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});

    res = await app.inject({ method: 'DELETE', url: '/accesses/a-1' });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});
