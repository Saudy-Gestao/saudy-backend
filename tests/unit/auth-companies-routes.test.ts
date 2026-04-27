import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import companyRoutes from '../../src/modules/auth/routes/companies';
import prisma from '../../src/modules/auth/lib/prisma';

const cnpjFns = vi.hoisted(() => ({
  findCompanyByNormalizedCnpj: vi.fn(),
  isValidNormalizedCnpj: vi.fn(),
  normalizeCnpj: vi.fn(),
}));

vi.mock('../../src/modules/auth/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    company: {
      findMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock('../../src/modules/auth/lib/cnpj', () => cnpjFns);

const mockedPrisma = prisma as any;

async function buildApp(userOverride?: { id: string; admHubOnly: boolean }) {
  const app = Fastify();
  app.decorateRequest('jwtVerify', async function jwtVerify() {});
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    (request as any).user = userOverride ?? { id: 'u-1', admHubOnly: false };
  });

  app.addSchema({ $id: 'Company', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'CompanyCreate', type: 'object', additionalProperties: true });

  await app.register(companyRoutes);
  return app;
}

describe('auth companies routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { companyId: 'c1' } } });
    cnpjFns.normalizeCnpj.mockReturnValue('12345678000195');
    cnpjFns.isValidNormalizedCnpj.mockReturnValue(true);
    cnpjFns.findCompanyByNormalizedCnpj.mockResolvedValue(null);
  });

  it('lists companies for scoped user and admHubOnly', async () => {
    mockedPrisma.company.findMany.mockResolvedValue([{ id: 'c1' }]);
    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/companies' });
    expect(res.statusCode).toBe(200);

    const admApp = await buildApp({ id: 'adm', admHubOnly: true });

    res = await admApp.inject({ method: 'GET', url: '/companies' });
    expect(res.statusCode).toBe(200);

    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/companies' });
    expect(res.statusCode).toBe(403);

    await admApp.close();
    await app.close();
  });

  it('creates company with cnpj validations', async () => {
    mockedPrisma.company.create.mockResolvedValue({ id: 'c1' });
    const app = await buildApp();

    cnpjFns.isValidNormalizedCnpj.mockReturnValueOnce(false);
    let res = await app.inject({ method: 'POST', url: '/companies', payload: { cnpj: 'x' } });
    expect(res.statusCode).toBe(400);

    cnpjFns.findCompanyByNormalizedCnpj.mockResolvedValueOnce({ id: 'exists' });
    res = await app.inject({ method: 'POST', url: '/companies', payload: { cnpj: 'ok' } });
    expect(res.statusCode).toBe(409);

    res = await app.inject({
      method: 'POST',
      url: '/companies',
      payload: { cnpj: 'ok', legalName: 'L', tradeName: 'T', address: 'A', phone: '1', additionalBranchesAllowed: -2 },
    });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('gets company by id with scope checks', async () => {
    mockedPrisma.company.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'c2' })
      .mockResolvedValueOnce({ id: 'c1' });

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/companies/c1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/companies/c1' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/companies/c1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('updates company with validation and conflict paths', async () => {
    mockedPrisma.company.findUnique.mockResolvedValue({ id: 'c1' });
    mockedPrisma.company.update.mockResolvedValue({ id: 'c1' });

    const app = await buildApp();

    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'PUT', url: '/companies/c1', payload: {} });
    expect(res.statusCode).toBe(403);

    mockedPrisma.company.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'PUT', url: '/companies/c1', payload: {} });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/companies/c2', payload: {} });
    expect(res.statusCode).toBe(403);

    cnpjFns.isValidNormalizedCnpj.mockReturnValueOnce(false);
    res = await app.inject({ method: 'PUT', url: '/companies/c1', payload: { cnpj: 'bad' } });
    expect(res.statusCode).toBe(400);

    cnpjFns.findCompanyByNormalizedCnpj.mockResolvedValueOnce({ id: 'other' });
    res = await app.inject({ method: 'PUT', url: '/companies/c1', payload: { cnpj: 'dup' } });
    expect(res.statusCode).toBe(409);

    res = await app.inject({ method: 'PUT', url: '/companies/c1', payload: { tradeName: 'Novo', additionalBranchesAllowed: -1 } });
    expect(res.statusCode).toBe(200);

    mockedPrisma.company.update.mockRejectedValueOnce(new Error('x'));
    res = await app.inject({ method: 'PUT', url: '/companies/c1', payload: { tradeName: 'Err' } });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('deletes company only for admHubOnly', async () => {
    mockedPrisma.company.delete.mockResolvedValue({});
    const app = await buildApp();

    let res = await app.inject({ method: 'DELETE', url: '/companies/c1' });
    expect(res.statusCode).toBe(403);

    const admApp = await buildApp({ id: 'adm', admHubOnly: true });

    res = await admApp.inject({ method: 'DELETE', url: '/companies/c1' });
    expect(res.statusCode).toBe(200);

    mockedPrisma.company.delete.mockRejectedValueOnce(new Error('missing'));
    res = await admApp.inject({ method: 'DELETE', url: '/companies/cx' });
    expect(res.statusCode).toBe(404);

    await admApp.close();
    await app.close();
  });
});
