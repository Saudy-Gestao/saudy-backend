import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import preAttendanceRoutes from '../../src/modules/care/routes/pre-attendances';
import prisma from '../../src/modules/care/lib/prisma';

vi.mock('../../src/lib/cpf', () => ({
  normalizeCpf: vi.fn((v: string) => String(v || '').replace(/\D/g, '')),
  isValidCpf: vi.fn(() => true),
}));

vi.mock('../../src/lib/email', () => ({
  normalizeEmail: vi.fn((v: string) => (v ? String(v).trim().toLowerCase() : '')),
  isValidEmail: vi.fn(() => true),
}));

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    preAttendance: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    appointment: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const mockedPrisma = prisma as any;

async function buildApp(opts?: { unauthorized?: boolean; noBranch?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1' };
  });

  mockedPrisma.user.findUnique.mockResolvedValue(
    opts?.noBranch ? { id: 'u-1', sector: null } : { id: 'u-1', sector: { branch: { id: 'b-1' } } },
  );

  await app.register(preAttendanceRoutes, { prefix: '/pa' });
  return app;
}

describe('care pre-attendances routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockedPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', sector: { branch: { id: 'b-1' } } });

    mockedPrisma.preAttendance.findMany.mockResolvedValue([]);
    mockedPrisma.preAttendance.count.mockResolvedValue(0);
    mockedPrisma.preAttendance.findFirst.mockResolvedValue({ id: 'pa-1', branchId: 'b-1', status: 'NA_FILA_DA_RECEPCAO', notes: null });
    mockedPrisma.preAttendance.create.mockResolvedValue({ id: 'pa-1' });
    mockedPrisma.preAttendance.update.mockResolvedValue({ id: 'pa-1' });
    mockedPrisma.preAttendance.delete.mockResolvedValue({ id: 'pa-1' });

    mockedPrisma.appointment.findMany.mockResolvedValue([]);
    mockedPrisma.$transaction.mockResolvedValue(undefined);
  });

  it('enforces auth and handles list with no branch', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/pa' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    const noBranch = await buildApp({ noBranch: true });
    res = await noBranch.inject({ method: 'GET', url: '/pa' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
    await noBranch.close();
  });

  it('lists pre-attendances and runs timing sync updates', async () => {
    const app = await buildApp();

    mockedPrisma.preAttendance.findMany
      .mockResolvedValueOnce([
        { id: 'pa-1', appointmentId: 'a-1', status: 'NA_FILA_DA_RECEPCAO', notes: null },
      ])
      .mockResolvedValueOnce([{ id: 'pa-1', fullName: 'Maria' }]);
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([
      { id: 'a-1', date: '2020-01-01', time: '10:00' },
    ]);

    const res = await app.inject({ method: 'GET', url: '/pa?search=Maria&limit=10&offset=0' });

    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(0);
    expect(mockedPrisma.$transaction).toHaveBeenCalled();

    await app.close();
  });

  it('gets by id and handles 404', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/pa/pa-1' });
    expect(res.statusCode).toBe(200);

    mockedPrisma.preAttendance.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/pa/pa-x' });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('creates with validation and handles create failure', async () => {
    const app = await buildApp();

    const cpfLib = await import('../../src/lib/cpf');
    const emailLib = await import('../../src/lib/email');

    (cpfLib.isValidCpf as any).mockReturnValueOnce(false);
    let res = await app.inject({ method: 'POST', url: '/pa', payload: { fullName: 'Maria', cpf: '123' } });
    expect(res.statusCode).toBe(400);

    (cpfLib.isValidCpf as any).mockReturnValue(true);
    (emailLib.isValidEmail as any).mockReturnValueOnce(false);
    res = await app.inject({ method: 'POST', url: '/pa', payload: { fullName: 'Maria', cpf: '11144477735', email: 'bad' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.preAttendance.create.mockRejectedValueOnce(new Error('create-fail'));
    res = await app.inject({ method: 'POST', url: '/pa', payload: { fullName: 'Maria', cpf: '11144477735' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/pa', payload: { fullName: 'Maria', cpf: '11144477735' } });
    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it('updates with transition/email rules and handles errors', async () => {
    const app = await buildApp();

    const emailLib = await import('../../src/lib/email');

    mockedPrisma.preAttendance.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'PUT', url: '/pa/pa-1', payload: { status: 'X' } });
    expect(res.statusCode).toBe(404);

    mockedPrisma.preAttendance.findFirst.mockResolvedValueOnce({ id: 'pa-1', branchId: 'b-1', status: 'FINALIZADO', notes: null });
    res = await app.inject({ method: 'PUT', url: '/pa/pa-1', payload: { status: 'NA_FILA_DA_RECEPCAO' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.preAttendance.findFirst.mockResolvedValueOnce({ id: 'pa-1', branchId: 'b-1', status: 'NA_FILA_DA_RECEPCAO', notes: null });
    (emailLib.isValidEmail as any).mockReturnValueOnce(false);
    res = await app.inject({ method: 'PUT', url: '/pa/pa-1', payload: { email: 'x' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.preAttendance.findFirst.mockResolvedValueOnce({ id: 'pa-1', branchId: 'b-1', status: 'NA_FILA_DA_RECEPCAO', notes: null });
    mockedPrisma.preAttendance.update.mockRejectedValueOnce(new Error('update-fail'));
    res = await app.inject({ method: 'PUT', url: '/pa/pa-1', payload: { status: 'EM_ATENDIMENTO_NA_RECEPCAO' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.preAttendance.findFirst.mockResolvedValueOnce({ id: 'pa-1', branchId: 'b-1', status: 'NA_FILA_DA_RECEPCAO', notes: null });
    res = await app.inject({ method: 'PUT', url: '/pa/pa-1', payload: { status: 'EM_ATENDIMENTO_NA_RECEPCAO' } });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('deletes and handles not found', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'DELETE', url: '/pa/pa-1' });
    expect(res.statusCode).toBe(200);

    mockedPrisma.preAttendance.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'DELETE', url: '/pa/pa-2' });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});
