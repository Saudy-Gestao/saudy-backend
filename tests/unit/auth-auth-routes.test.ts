import crypto from 'crypto';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import authRoutes from '../../src/modules/auth/routes/auth';
import prisma from '../../src/modules/auth/lib/prisma';
import bcrypt from 'bcryptjs';
import {
  sendAdminRegisterCodeEmail,
  sendPasswordResetCodeEmail,
  sendWelcomeEmail,
} from '../../src/modules/auth/lib/mailer';
import {
  findCompanyByNormalizedCnpj,
  isValidNormalizedCnpj,
  normalizeCnpj,
} from '../../src/modules/auth/lib/cnpj';

vi.mock('../../src/modules/auth/lib/prisma', () => ({
  default: {
    adminUser: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    passwordResetCode: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('bcryptjs', () => ({
  default: {
    compare: vi.fn(),
    hash: vi.fn(),
  },
}));

vi.mock('../../src/modules/auth/lib/mailer', () => ({
  sendAdminRegisterCodeEmail: vi.fn(),
  sendPasswordResetCodeEmail: vi.fn(),
  sendWelcomeEmail: vi.fn(),
}));

vi.mock('../../src/modules/auth/lib/cnpj', () => ({
  normalizeCnpj: vi.fn(),
  isValidNormalizedCnpj: vi.fn(),
  findCompanyByNormalizedCnpj: vi.fn(),
}));

const mockedPrisma = prisma as any;
const mockedBcrypt = bcrypt as any;
const mockedSendAdminRegisterCodeEmail = sendAdminRegisterCodeEmail as any;
const mockedSendPasswordResetCodeEmail = sendPasswordResetCodeEmail as any;
const mockedSendWelcomeEmail = sendWelcomeEmail as any;
const mockedNormalizeCnpj = normalizeCnpj as any;
const mockedIsValidNormalizedCnpj = isValidNormalizedCnpj as any;
const mockedFindCompanyByNormalizedCnpj = findCompanyByNormalizedCnpj as any;

function hashCode(code: string) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

async function buildApp() {
  const app = Fastify();

  app.decorate('jwt', {
    sign: vi.fn(() => 'jwt-token'),
    verify: vi.fn(),
    decode: vi.fn(),
  } as any);

  app.addSchema({ $id: 'AuthResponse', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'RegisterRequest', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'RegisterResponse', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'LoginRequest', type: 'object', additionalProperties: true });

  await app.register(authRoutes);
  return app;
}

describe('auth routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('handles /adm/login invalid credentials and unverified account', async () => {
    mockedPrisma.adminUser.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'adm-1', password: 'hash', emailVerifiedAt: new Date(), email: 'adm@etechdev' })
      .mockResolvedValueOnce({ id: 'adm-2', password: 'hash', emailVerifiedAt: null, email: 'adm2@etechdev' });
    mockedBcrypt.compare.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const app = await buildApp();

    const missing = await app.inject({
      method: 'POST',
      url: '/adm/login',
      payload: { email: 'none@etechdev', password: 'x' },
    });
    expect(missing.statusCode).toBe(401);

    const wrongPass = await app.inject({
      method: 'POST',
      url: '/adm/login',
      payload: { email: 'adm@etechdev', password: 'x' },
    });
    expect(wrongPass.statusCode).toBe(401);

    const unverified = await app.inject({
      method: 'POST',
      url: '/adm/login',
      payload: { email: 'adm2@etechdev', password: 'x' },
    });
    expect(unverified.statusCode).toBe(403);

    await app.close();
  });

  it('handles /adm/login success', async () => {
    mockedPrisma.adminUser.findFirst.mockResolvedValue({
      id: 'adm-1',
      name: 'ADM',
      email: 'adm@etechdev',
      password: 'hash',
      emailVerifiedAt: new Date(),
    });
    mockedBcrypt.compare.mockResolvedValue(true);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/adm/login',
      payload: { email: 'adm@etechdev', password: 'Strong@123' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBe('jwt-token');

    await app.close();
  });

  it('handles /adm/request-register-code validation failures and mail failure', async () => {
    mockedBcrypt.hash.mockResolvedValue('hashed-pass');
    mockedSendAdminRegisterCodeEmail.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('smtp'));

    const app = await buildApp();

    const required = await app.inject({
      method: 'POST',
      url: '/adm/request-register-code',
      payload: { name: '', email: '', password: '' },
    });
    expect(required.statusCode).toBe(400);

    const domain = await app.inject({
      method: 'POST',
      url: '/adm/request-register-code',
      payload: { name: 'ADM', email: 'adm@gmail.com', password: 'Strong@123' },
    });
    expect(domain.statusCode).toBe(400);

    const weakPass = await app.inject({
      method: 'POST',
      url: '/adm/request-register-code',
      payload: { name: 'ADM', email: 'adm@etechdev', password: 'weak' },
    });
    expect(weakPass.statusCode).toBe(400);

    const notConfigured = await app.inject({
      method: 'POST',
      url: '/adm/request-register-code',
      payload: { name: 'ADM', email: 'adm@etechdev', password: 'Strong@123' },
    });
    expect(notConfigured.statusCode).toBe(500);

    const threw = await app.inject({
      method: 'POST',
      url: '/adm/request-register-code',
      payload: { name: 'ADM', email: 'adm@etechdev', password: 'Strong@123' },
    });
    expect(threw.statusCode).toBe(500);

    await app.close();
  });

  it('handles /adm/request-register-code success', async () => {
    mockedBcrypt.hash.mockResolvedValue('hashed-pass');
    mockedSendAdminRegisterCodeEmail.mockResolvedValue(true);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/adm/request-register-code',
      payload: { name: 'ADM', email: 'adm@etechdev', password: 'Strong@123' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.adminUser.upsert).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('handles /adm/verify-register-code invalid and success scenarios', async () => {
    mockedPrisma.adminUser.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'adm-1', emailCodeHash: null, emailCodeExpiresAt: null })
      .mockResolvedValueOnce({ id: 'adm-1', emailCodeHash: hashCode('123456'), emailCodeExpiresAt: new Date(Date.now() - 1) })
      .mockResolvedValueOnce({ id: 'adm-1', emailCodeHash: hashCode('123456'), emailCodeExpiresAt: new Date(Date.now() + 60000) })
      .mockResolvedValueOnce({ id: 'adm-1', email: 'adm@etechdev', name: 'ADM', emailCodeHash: hashCode('123456'), emailCodeExpiresAt: new Date(Date.now() + 60000) });
    mockedPrisma.adminUser.update.mockResolvedValue({ id: 'adm-1', email: 'adm@etechdev', name: 'ADM' });

    const app = await buildApp();

    const a = await app.inject({ method: 'POST', url: '/adm/verify-register-code', payload: { email: 'adm@etechdev', code: '123456' } });
    expect(a.statusCode).toBe(400);

    const b = await app.inject({ method: 'POST', url: '/adm/verify-register-code', payload: { email: 'adm@etechdev', code: '123456' } });
    expect(b.statusCode).toBe(400);

    const c = await app.inject({ method: 'POST', url: '/adm/verify-register-code', payload: { email: 'adm@etechdev', code: '123456' } });
    expect(c.statusCode).toBe(400);

    const d = await app.inject({ method: 'POST', url: '/adm/verify-register-code', payload: { email: 'adm@etechdev', code: '654321' } });
    expect(d.statusCode).toBe(400);

    const ok = await app.inject({ method: 'POST', url: '/adm/verify-register-code', payload: { email: 'adm@etechdev', code: '123456' } });
    expect(ok.statusCode).toBe(200);

    await app.close();
  });

  it('handles /register happy path and cnpj/domain errors', async () => {
    mockedNormalizeCnpj.mockReturnValue('12345678000195');
    mockedIsValidNormalizedCnpj.mockReturnValueOnce(false).mockReturnValueOnce(true).mockReturnValueOnce(true);
    mockedFindCompanyByNormalizedCnpj.mockResolvedValueOnce({ id: 'c-existing' });
    mockedBcrypt.hash.mockResolvedValue('bcrypt-password');
    mockedSendWelcomeEmail.mockResolvedValue(true);

    const tx = {
      company: { create: vi.fn().mockResolvedValue({ id: 'c-1', cnpj: '12345678000195' }) },
      branch: { create: vi.fn().mockResolvedValue({ id: 'b-1', isMatriz: true }) },
      sector: { create: vi.fn().mockResolvedValue({ id: 's-1', name: 'Setor' }) },
      access: { create: vi.fn().mockResolvedValue({ id: 'a-1', description: 'Acesso' }) },
      user: {
        create: vi.fn().mockResolvedValue({
          id: 'u-1',
          name: 'User',
          email: 'user@mail.com',
          phone: '1',
          address: 'Addr',
          birthDate: new Date('2000-01-01'),
          sector: { id: 's-1' },
          accesses: [{ id: 'a-1' }],
        }),
      },
    };

    mockedPrisma.$transaction
      .mockImplementationOnce(async (cb: any) => cb(tx))
      .mockImplementationOnce(async (cb: any) => cb(tx))
      .mockImplementationOnce(async (cb: any) => cb(tx));

    const app = await buildApp();

    const payload = {
      company: { cnpj: '12.345.678/0001-95', legalName: 'Legal', tradeName: 'Trade', address: 'Addr', phone: '1' },
      branch: { tradeName: 'Matriz', address: 'Addr', phone: '1' },
      sector: { name: 'Setor', description: 'Desc' },
      user: {
        name: 'User',
        birthDate: '2000-01-01',
        email: 'User@Mail.com',
        password: 'Strong@123',
        phone: '1',
        address: 'Addr',
      },
      accesses: [{ description: 'Acesso' }],
      branchesCount: 1,
      modulo: 'padrao',
    };

    const invalid = await app.inject({ method: 'POST', url: '/register', payload });
    expect(invalid.statusCode).toBe(400);

    const duplicate = await app.inject({ method: 'POST', url: '/register', payload });
    expect(duplicate.statusCode).toBe(409);

    mockedFindCompanyByNormalizedCnpj.mockResolvedValueOnce(null);
    const ok = await app.inject({ method: 'POST', url: '/register', payload });
    expect(ok.statusCode).toBe(200);

    await app.close();
  });

  it('handles /login with admin and user fallbacks, including plain password upgrade', async () => {
    mockedPrisma.adminUser.findUnique
      .mockResolvedValueOnce({ id: 'adm-1', name: 'ADM', email: 'adm@etechdev', password: 'hash', emailVerifiedAt: null })
      .mockResolvedValueOnce({ id: 'adm-1', name: 'ADM', email: 'adm@etechdev', password: 'hash', emailVerifiedAt: new Date() })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    mockedBcrypt.compare
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    mockedPrisma.user.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'u-1',
          name: 'User',
          email: 'USER@mail.com',
          password: 'plainpass',
          sector: { branch: { id: 'b-1', companyId: 'c-1' } },
          accesses: [],
          doctor: null,
        },
      ]);

    mockedPrisma.user.findFirst
      .mockResolvedValueOnce({
        id: 'u-2',
        name: 'Cpf User',
        email: 'cpf@mail.com',
        password: 'x',
        sector: { branch: { id: 'b-2', companyId: 'c-2' } },
        accesses: [],
        doctor: null,
      });

    mockedBcrypt.hash.mockResolvedValue('upgraded-hash');

    const app = await buildApp();

    const unverified = await app.inject({ method: 'POST', url: '/login', payload: { email: 'adm@etechdev', password: 'x' } });
    expect(unverified.statusCode).toBe(403);

    const adminOk = await app.inject({ method: 'POST', url: '/login', payload: { email: 'adm@etechdev', password: 'x' } });
    expect(adminOk.statusCode).toBe(200);

    const invalid = await app.inject({ method: 'POST', url: '/login', payload: { email: 'nobody@mail.com', password: 'x' } });
    expect(invalid.statusCode).toBe(401);

    const plain = await app.inject({ method: 'POST', url: '/login', payload: { email: 'user@mail.com', password: 'plainpass' } });
    expect(plain.statusCode).toBe(200);
    expect(mockedPrisma.user.update).toHaveBeenCalled();

    const cpfLogin = await app.inject({ method: 'POST', url: '/login', payload: { email: '123.456.789-00', password: 'x' } });
    expect(cpfLogin.statusCode).toBe(200);

    await app.close();
  });

  it('handles /forgot-password generic response and send-mail failure path', async () => {
    mockedPrisma.user.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'u-1', email: 'user@mail.com', name: 'User' }]);
    mockedSendPasswordResetCodeEmail.mockRejectedValueOnce(new Error('smtp')); 

    const app = await buildApp();

    const blank = await app.inject({ method: 'POST', url: '/forgot-password', payload: { identifier: '   ' } });
    expect(blank.statusCode).toBe(200);

    const notFound = await app.inject({ method: 'POST', url: '/forgot-password', payload: { identifier: 'nobody@mail.com' } });
    expect(notFound.statusCode).toBe(200);

    const ok = await app.inject({ method: 'POST', url: '/forgot-password', payload: { identifier: 'user@mail.com' } });
    expect(ok.statusCode).toBe(200);
    expect(mockedPrisma.passwordResetCode.create).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('handles /verify-code invalid attempts and success', async () => {
    mockedPrisma.user.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'u-1', email: 'user@mail.com', name: 'User' }])
      .mockResolvedValueOnce([{ id: 'u-1', email: 'user@mail.com', name: 'User' }])
      .mockResolvedValueOnce([{ id: 'u-1', email: 'user@mail.com', name: 'User' }])
      .mockResolvedValueOnce([{ id: 'u-1', email: 'user@mail.com', name: 'User' }]);

    mockedPrisma.passwordResetCode.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'r-1', attempts: 1, codeHash: hashCode('111111') })
      .mockResolvedValueOnce({ id: 'r-2', attempts: 4, codeHash: hashCode('222222') })
      .mockResolvedValueOnce({ id: 'r-3', attempts: 0, codeHash: hashCode('333333') });

    const app = await buildApp();

    const noUser = await app.inject({ method: 'POST', url: '/verify-code', payload: { identifier: 'none@mail.com', code: '111111' } });
    expect(noUser.statusCode).toBe(400);

    const noRecord = await app.inject({ method: 'POST', url: '/verify-code', payload: { identifier: 'user@mail.com', code: '111111' } });
    expect(noRecord.statusCode).toBe(400);

    const wrong = await app.inject({ method: 'POST', url: '/verify-code', payload: { identifier: 'user@mail.com', code: '999999' } });
    expect(wrong.statusCode).toBe(400);

    const consume = await app.inject({ method: 'POST', url: '/verify-code', payload: { identifier: 'user@mail.com', code: '999999' } });
    expect(consume.statusCode).toBe(400);

    const valid = await app.inject({ method: 'POST', url: '/verify-code', payload: { identifier: 'user@mail.com', code: '333333' } });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({ valid: true });

    await app.close();
  });

  it('handles /reset-password validation, invalid code and success transaction', async () => {
    mockedPrisma.user.findMany
      .mockResolvedValueOnce([{ id: 'u-1', email: 'user@mail.com', name: 'User' }])
      .mockResolvedValueOnce([{ id: 'u-1', email: 'user@mail.com', name: 'User' }]);

    mockedPrisma.passwordResetCode.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'r-1', userId: 'u-1', codeHash: hashCode('123456') });

    mockedBcrypt.hash.mockResolvedValue('new-hash');
    mockedPrisma.$transaction.mockImplementation(async (ops: any) => {
      if (Array.isArray(ops)) return Promise.all(ops);
      return ops;
    });
    mockedPrisma.user.update.mockResolvedValue({ id: 'u-1' });
    mockedPrisma.passwordResetCode.update.mockResolvedValue({ id: 'r-1' });

    const app = await buildApp();

    const weak = await app.inject({
      method: 'POST',
      url: '/reset-password',
      payload: { identifier: 'user@mail.com', code: '123456', newPassword: 'weak' },
    });
    expect(weak.statusCode).toBe(400);

    const invalid = await app.inject({
      method: 'POST',
      url: '/reset-password',
      payload: { identifier: 'user@mail.com', code: '123456', newPassword: 'Strong@123' },
    });
    expect(invalid.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'POST',
      url: '/reset-password',
      payload: { identifier: 'user@mail.com', code: '123456', newPassword: 'Strong@123' },
    });
    expect(ok.statusCode).toBe(200);

    await app.close();
  });
});
