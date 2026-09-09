import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import internRoutes from '../../src/modules/accounts/routes/interns';
import prisma from '../../src/modules/accounts/lib/prisma';

vi.mock('../../src/modules/accounts/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    branch: { findFirst: vi.fn() },
    especialidade: { findFirst: vi.fn() },
    doctor: { findMany: vi.fn() },
    intern: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    internDoctor: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const mockedPrisma = prisma as any;

const internRecord = {
  id: 'i-1',
  name: 'Estagiário Teste',
  branchId: 'b-1',
  especialidadeId: null,
  workingSchedules: '[]',
  doctors: [{ doctorId: 'd-1', doctor: { id: 'd-1', name: 'Dr. X' } }],
};

async function buildApp(opts?: { unauthorized?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1' };
  });

  await app.register(internRoutes, { prefix: '/interns' });
  return app;
}

describe('accounts interns routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 'u-1',
      sector: { branch: { id: 'b-1', companyId: 'c-1' } },
    });
    mockedPrisma.branch.findFirst.mockResolvedValue({ id: 'b-1' });
    mockedPrisma.especialidade.findFirst.mockResolvedValue({ id: 'esp-1' });
    mockedPrisma.doctor.findMany.mockResolvedValue([{ id: 'd-1' }]);
    mockedPrisma.intern.findMany.mockResolvedValue([internRecord]);
    mockedPrisma.intern.findFirst.mockResolvedValue(internRecord);
    mockedPrisma.intern.create.mockResolvedValue(internRecord);
    mockedPrisma.intern.deleteMany.mockResolvedValue({ count: 1 });
    mockedPrisma.internDoctor.deleteMany.mockResolvedValue({ count: 0 });
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn({
      internDoctor: mockedPrisma.internDoctor,
      intern: { update: vi.fn().mockResolvedValue(internRecord) },
    }));
  });

  it('rejects unauthorized requests', async () => {
    const app = await buildApp({ unauthorized: true });
    const res = await app.inject({ method: 'GET', url: '/interns' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects when user has no branch', async () => {
    mockedPrisma.user.findUnique.mockResolvedValueOnce({ sector: null });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/interns' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('lists interns filtering by search and branchId', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/interns' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].professionalIds).toEqual(['d-1']);

    res = await app.inject({ method: 'GET', url: '/interns?search=Ana&branchId=b-1' });
    expect(res.statusCode).toBe(200);

    mockedPrisma.branch.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/interns?branchId=b-invalid' });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('creates an intern, validating name, branch, doctors and especialidade', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/interns', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Nome/);

    mockedPrisma.branch.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'POST', url: '/interns', payload: { name: 'Ana', branchId: 'b-invalid' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Unidade/);

    mockedPrisma.doctor.findMany.mockResolvedValueOnce([]);
    res = await app.inject({ method: 'POST', url: '/interns', payload: { name: 'Ana', professionalIds: ['d-1'] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Profissional/);

    mockedPrisma.especialidade.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'POST', url: '/interns', payload: { name: 'Ana', especialidadeId: 'esp-invalid' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Especialidade/);

    res = await app.inject({
      method: 'POST',
      url: '/interns',
      payload: {
        name: 'Ana',
        cpf: '123',
        email: 'ana@x.com',
        phone: '119999',
        institution: 'Faculdade X',
        course: 'Fisioterapia',
        startDate: '2024-01-01',
        endDate: '2024-06-01',
        professionalIds: ['d-1'],
        especialidadeId: 'esp-1',
        workingSchedules: [{ days: ['seg'], hoursStart: '08:00', hoursEnd: '12:00' }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(mockedPrisma.intern.create).toHaveBeenCalled();

    await app.close();
  });

  it('creates an intern using legacy workingDays/workingHoursStart/End fields', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/interns',
      payload: { name: 'Ana', workingDays: ['seg'], workingHoursStart: '08:00', workingHoursEnd: '12:00' },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('updates an intern, 404 when not found, and reuses current schedules', async () => {
    const app = await buildApp();

    mockedPrisma.intern.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'PUT', url: '/interns/i-1', payload: { name: 'X' } });
    expect(res.statusCode).toBe(404);

    mockedPrisma.intern.findFirst.mockResolvedValueOnce({
      ...internRecord,
      workingSchedules: JSON.stringify([{ days: ['seg'], hoursStart: '08:00', hoursEnd: '12:00' }]),
    });
    res = await app.inject({ method: 'PUT', url: '/interns/i-1', payload: { isActive: false } });
    expect(res.statusCode).toBe(200);

    mockedPrisma.branch.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'PUT', url: '/interns/i-1', payload: { branchId: 'b-invalid' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.doctor.findMany.mockResolvedValueOnce([]);
    res = await app.inject({ method: 'PUT', url: '/interns/i-1', payload: { professionalIds: ['d-1'] } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.especialidade.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'PUT', url: '/interns/i-1', payload: { especialidadeId: 'esp-invalid' } });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('deletes an intern and returns 404 when not found', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'DELETE', url: '/interns/i-1' });
    expect(res.statusCode).toBe(200);

    mockedPrisma.intern.deleteMany.mockResolvedValueOnce({ count: 0 });
    res = await app.inject({ method: 'DELETE', url: '/interns/i-missing' });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});
