import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import userRoutes from '../../src/modules/auth/routes/users';
import prisma from '../../src/modules/auth/lib/prisma';
import bcrypt from 'bcryptjs';
import { sendWelcomeEmail } from '../../src/modules/auth/lib/mailer';

vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn() },
}));

vi.mock('../../src/modules/auth/lib/mailer', () => ({
  sendWelcomeEmail: vi.fn(),
}));

vi.mock('../../src/modules/auth/lib/prisma', () => ({
  default: {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    branch: {
      findFirst: vi.fn(),
    },
    sector: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    doctor: {
      findFirst: vi.fn(),
    },
  },
}));

const mockedPrisma = prisma as any;
const mockedBcrypt = bcrypt as any;
const mockedSendWelcomeEmail = sendWelcomeEmail as any;

async function buildApp() {
  const app = Fastify();
  app.decorateRequest('jwtVerify', async function jwtVerify() {});
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    (request as any).user = { id: 'u-logged' };
  });

  app.addSchema({ $id: 'UserCreate', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'UserUpdate', type: 'object', additionalProperties: true });

  await app.register(userRoutes);
  return app;
}

describe('auth users routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedBcrypt.hash.mockResolvedValue('hashed');
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 'u-logged',
      sector: { branch: { id: 'b1', companyId: 'c1' } },
    });
  });

  it('lists users and blocks when logged user has no company', async () => {
    mockedPrisma.user.findMany.mockResolvedValue([{ id: 'u1' }]);

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/users' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: 'u1' }]);

    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/users' });
    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it('creates user with validations and welcome email path', async () => {
    mockedPrisma.branch.findFirst.mockResolvedValue({ id: 'b1' });
    mockedPrisma.sector.findFirst.mockResolvedValue({ id: 's1', name: 'Recepção', description: '' });
    mockedPrisma.doctor.findFirst.mockResolvedValue({ id: 'd1', email: 'doc@mail.com' });
    mockedPrisma.user.create.mockResolvedValue({ id: 'u1', name: 'Ana' });

    const app = await buildApp();

    let res = await app.inject({
      method: 'POST',
      url: '/users',
      payload: {
        branchId: '',
        sectorId: 's1',
        accessIds: [],
        name: 'Ana',
        birthDate: '1990-01-01',
        email: 'ana@mail.com',
        password: '123456',
        phone: '1',
        address: 'a',
      },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/users',
      payload: {
        branchId: 'bX',
        sectorId: 's1',
        accessIds: [],
        name: 'Ana',
        birthDate: '1990-01-01',
        email: 'ana@mail.com',
        password: '123456',
        phone: '1',
        address: 'a',
      },
    });
    expect(res.statusCode).toBe(200);

    mockedPrisma.branch.findFirst.mockResolvedValueOnce({ id: 'b1' });
    res = await app.inject({
      method: 'POST',
      url: '/users',
      payload: {
        branchId: 'b1',
        sectorId: 's1',
        accessIds: [],
        name: 'Ana',
        birthDate: '1990-01-01',
        email: 'bad',
        password: '123456',
        phone: '1',
        address: 'a',
      },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.branch.findFirst.mockResolvedValueOnce({ id: 'b1' });
    mockedPrisma.sector.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({
      method: 'POST',
      url: '/users',
      payload: {
        branchId: 'b1',
        sectorId: 'sX',
        accessIds: [],
        name: 'Ana',
        birthDate: '1990-01-01',
        email: 'ana@mail.com',
        password: '123456',
        phone: '1',
        address: 'a',
      },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.branch.findFirst.mockResolvedValueOnce({ id: 'b1' });
    mockedPrisma.sector.findFirst.mockResolvedValueOnce({ id: 's1', name: 'Sala 1', description: '' });
    res = await app.inject({
      method: 'POST',
      url: '/users',
      payload: {
        branchId: 'b1',
        sectorId: 's1',
        accessIds: [],
        name: 'Ana',
        birthDate: '1990-01-01',
        email: 'ana@mail.com',
        password: '123456',
        phone: '1',
        address: 'a',
      },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.branch.findFirst.mockResolvedValueOnce({ id: 'b1' });
    mockedPrisma.sector.findFirst.mockResolvedValueOnce({ id: 's1', name: 'Recepção', description: '' });
    mockedPrisma.doctor.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({
      method: 'POST',
      url: '/users',
      payload: {
        branchId: 'b1',
        sectorId: 's1',
        doctorId: 'dX',
        accessIds: [],
        name: 'Ana',
        birthDate: '1990-01-01',
        email: 'ana@mail.com',
        password: '123456',
        phone: '1',
        address: 'a',
      },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.branch.findFirst.mockResolvedValueOnce({ id: 'b1' });
    mockedPrisma.sector.findFirst.mockResolvedValueOnce({ id: 's1', name: 'Recepção', description: '' });
    mockedPrisma.doctor.findFirst.mockResolvedValueOnce({ id: 'd1', email: 'doc@mail.com' });
    mockedPrisma.user.create.mockResolvedValueOnce({ id: 'u1', name: 'Ana' });

    res = await app.inject({
      method: 'POST',
      url: '/users',
      payload: {
        branchId: 'b1',
        sectorId: 's1',
        doctorId: 'd1',
        accessIds: ['a1'],
        name: 'Ana',
        birthDate: '1990-01-01',
        email: 'ana@mail.com',
        password: '123456',
        phone: '1',
        address: 'a',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(mockedSendWelcomeEmail).toHaveBeenCalled();

    mockedPrisma.branch.findFirst.mockResolvedValueOnce({ id: 'b1' });
    mockedPrisma.sector.findFirst.mockResolvedValueOnce({ id: 's1', name: 'Recepção', description: '' });
    mockedPrisma.user.create.mockResolvedValueOnce({ id: 'u2', name: 'Ana' });
    mockedSendWelcomeEmail.mockRejectedValueOnce(new Error('mail fail'));

    res = await app.inject({
      method: 'POST',
      url: '/users',
      payload: {
        branchId: 'b1',
        sectorId: 's1',
        accessIds: ['a1'],
        name: 'Ana',
        birthDate: '1990-01-01',
        email: 'ana2@mail.com',
        password: '123456',
        phone: '1',
        address: 'a',
      },
    });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('gets user by id with scope checks', async () => {
    let u2Lookups = 0;
    mockedPrisma.user.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === 'u-logged') return { id: 'u-logged', sector: { branch: { id: 'b1', companyId: 'c1' } } };
      if (where.id === 'u2') {
        u2Lookups += 1;
        if (u2Lookups === 1) return null;
        return { id: 'u2', sector: { branch: { companyId: 'c2' } } };
      }
      if (where.id === 'u3') return { id: 'u3', sector: { branch: { companyId: 'c1' } } };
      return null;
    });

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/users/u2' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/users/u2' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/users/u3' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('updates user with validations and fallback error', async () => {
    let u1Lookups = 0;
    let failLoggedLookup = false;
    mockedPrisma.user.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === 'u-logged') {
        if (failLoggedLookup) throw new Error('boom');
        return { id: 'u-logged', sector: { branch: { id: 'b1', companyId: 'c1' } } };
      }
      if (where.id === 'u1') {
        u1Lookups += 1;
        if (u1Lookups === 1) return null;
        if (u1Lookups === 2) return { id: 'u1', sector: { branch: { id: 'b1', companyId: 'c2' } } };
        return { id: 'u1', sector: { branch: { id: 'b1', companyId: 'c1' } } };
      }
      return null;
    });

    mockedPrisma.sector.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 's1', branchId: 'b2', branch: { companyId: 'c1' }, name: 'Recepção', description: '' })
      .mockResolvedValueOnce({ id: 's1', branchId: 'b1', branch: { companyId: 'c1' }, name: 'Sala 2', description: '' })
      .mockResolvedValueOnce({ id: 's1', branchId: 'b1', branch: { companyId: 'c1' }, name: 'Recepção', description: '' });

    mockedPrisma.doctor.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'd1' });

    mockedPrisma.user.update.mockResolvedValue({ id: 'u1' });

    const app = await buildApp();

    let res = await app.inject({ method: 'PUT', url: '/users/u1', payload: { name: 'A' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/users/u1', payload: { name: 'A' } });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'PUT', url: '/users/u1', payload: { branchId: 'b2' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PUT', url: '/users/u1', payload: { email: 'bad' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PUT', url: '/users/u1', payload: { sectorId: 'sx' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PUT', url: '/users/u1', payload: { branchId: 'b1', sectorId: 's1' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PUT', url: '/users/u1', payload: { sectorId: 's1' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PUT', url: '/users/u1', payload: { doctorId: 'dx' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PUT', url: '/users/u1', payload: { doctorId: 'd1', password: '123456' } });
    expect(res.statusCode).toBe(200);

    failLoggedLookup = true;
    res = await app.inject({ method: 'PUT', url: '/users/u1', payload: { name: 'x' } });
    expect(res.statusCode).toBe(500);

    await app.close();
  });

  it('deletes user with scope checks', async () => {
    let u3Lookups = 0;
    let failLoggedLookup = false;
    mockedPrisma.user.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === 'u-logged') {
        if (failLoggedLookup) throw new Error('x');
        return { id: 'u-logged', sector: { branch: { id: 'b1', companyId: 'c1' } } };
      }
      if (where.id === 'u1') return null;
      if (where.id === 'u2') return { id: 'u2', sector: { branch: { id: 'b1', companyId: 'c2' } } };
      if (where.id === 'u3') {
        u3Lookups += 1;
        if (u3Lookups === 1) return { id: 'u3', sector: { branch: { id: 'b1', companyId: 'c1' } } };
        return null;
      }
      return null;
    });
    mockedPrisma.user.delete.mockResolvedValue({});

    const app = await buildApp();

    let res = await app.inject({ method: 'DELETE', url: '/users/u1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/users/u2' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'DELETE', url: '/users/u3' });
    expect(res.statusCode).toBe(200);

    failLoggedLookup = true;
    res = await app.inject({ method: 'DELETE', url: '/users/u3' });
    expect(res.statusCode).toBe(500);

    await app.close();
  });
});
