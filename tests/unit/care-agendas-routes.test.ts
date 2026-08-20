import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import agendaRoutes from '../../src/modules/care/routes/agendas';
import prisma from '../../src/modules/care/lib/prisma';

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    branch: { findMany: vi.fn(), findFirst: vi.fn() },
    doctor: { findUnique: vi.fn() },
    especialidade: { findUnique: vi.fn() },
    sector: { findUnique: vi.fn() },
    agenda: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

const mockedPrisma = prisma as any;

async function buildApp() {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    this.user = { id: 'u-1' };
  });
  await app.register(agendaRoutes);
  return app;
}

const doctor = {
  id: 'd-1',
  branchId: 'b-1',
  branchIds: ['b-1'],
  especialidadeGroups: JSON.stringify([{ modalidadeId: 'm-1', especialidadeId: 'e-1', metodos: [], procedimentoIds: [] }]),
};

describe('care agendas routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', name: 'Lucas', sector: { branch: { companyId: 'c-1' } } });
    mockedPrisma.branch.findFirst.mockResolvedValue({ id: 'b-1', companyId: 'c-1' });
    mockedPrisma.branch.findMany.mockResolvedValue([{ id: 'b-1' }]);
    mockedPrisma.doctor.findUnique.mockResolvedValue(doctor);
    mockedPrisma.especialidade.findUnique.mockResolvedValue({ id: 'e-1', modalidadeId: 'm-1' });
    mockedPrisma.sector.findUnique.mockResolvedValue({ id: 'r-1', branchId: 'b-1' });
    mockedPrisma.agenda.findMany.mockResolvedValue([]);
    mockedPrisma.agenda.create.mockResolvedValue({ id: 'a-1' });
    mockedPrisma.agenda.update.mockResolvedValue({ id: 'a-1' });
  });

  it('requires auth and company context', async () => {
    const app = await buildApp();
    mockedPrisma.user.findUnique.mockResolvedValueOnce({ sector: null });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('lists agendas scoped to company branches', async () => {
    mockedPrisma.agenda.findMany.mockResolvedValueOnce([{ id: 'a-1' }]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/?doctorId=d-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    await app.close();
  });

  it('creates agenda validating branch, doctor, especialidade, room and shift', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/', payload: { doctorId: 'd-1', weekday: 'segunda', shiftStart: '08:00', shiftEnd: '12:00' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.branch.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'POST', url: '/', payload: { branchId: 'b-x', doctorId: 'd-1', weekday: 'segunda', shiftStart: '08:00', shiftEnd: '12:00' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.doctor.findUnique.mockResolvedValueOnce({ ...doctor, branchIds: ['b-2'], branchId: 'b-2' });
    res = await app.inject({ method: 'POST', url: '/', payload: { branchId: 'b-1', doctorId: 'd-1', weekday: 'segunda', shiftStart: '08:00', shiftEnd: '12:00' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/', payload: { branchId: 'b-1', doctorId: 'd-1', weekday: 'inválido', shiftStart: '08:00', shiftEnd: '12:00' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/', payload: { branchId: 'b-1', doctorId: 'd-1', weekday: 'segunda', shiftStart: '12:00', shiftEnd: '08:00' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.especialidade.findUnique.mockResolvedValueOnce({ id: 'e-2', modalidadeId: 'm-2' });
    res = await app.inject({ method: 'POST', url: '/', payload: { branchId: 'b-1', doctorId: 'd-1', weekday: 'segunda', shiftStart: '08:00', shiftEnd: '12:00', especialidadeId: 'e-2' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.sector.findUnique.mockResolvedValueOnce({ id: 'r-2', branchId: 'b-2' });
    res = await app.inject({ method: 'POST', url: '/', payload: { branchId: 'b-1', doctorId: 'd-1', weekday: 'segunda', shiftStart: '08:00', shiftEnd: '12:00', roomId: 'r-2' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/', payload: { branchId: 'b-1', doctorId: 'd-1', weekday: 'segunda', shiftStart: '08:00', shiftEnd: '12:00', startDate: '2026-05-01', endDate: '2026-01-01' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.agenda.findMany.mockResolvedValueOnce([{ id: 'a-existing', shiftStart: '10:00', shiftEnd: '14:00', startDate: null, endDate: null }]);
    res = await app.inject({ method: 'POST', url: '/', payload: { branchId: 'b-1', doctorId: 'd-1', weekday: 'segunda', shiftStart: '08:00', shiftEnd: '12:00' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('AGENDA_OVERLAP');

    res = await app.inject({
      method: 'POST',
      url: '/',
      payload: { branchId: 'b-1', doctorId: 'd-1', weekday: 'segunda', shiftStart: '08:00', shiftEnd: '12:00', especialidadeId: 'e-1', roomId: 'r-1', startDate: '2026-01-01' },
    });
    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it('gets, updates and deletes an agenda with company ownership checks', async () => {
    const app = await buildApp();

    mockedPrisma.agenda.findUnique.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'GET', url: '/a-1' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.agenda.findUnique.mockResolvedValueOnce({ id: 'a-1', branchId: 'b-1' });
    mockedPrisma.branch.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/a-1' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.agenda.findUnique.mockResolvedValueOnce({ id: 'a-1', branchId: 'b-1' });
    res = await app.inject({ method: 'GET', url: '/a-1' });
    expect(res.statusCode).toBe(200);

    mockedPrisma.agenda.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'PUT', url: '/a-1', payload: { status: 'INATIVA' } });
    expect(res.statusCode).toBe(404);

    mockedPrisma.agenda.findUnique.mockResolvedValue({
      id: 'a-1', branchId: 'b-1', doctorId: 'd-1', weekday: 'segunda', shiftStart: '08:00', shiftEnd: '12:00',
      especialidadeId: null, roomId: null, startDate: null, endDate: null, status: 'ATIVA',
    });
    res = await app.inject({ method: 'PUT', url: '/a-1', payload: { status: 'INATIVA' } });
    expect(res.statusCode).toBe(200);

    mockedPrisma.agenda.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'DELETE', url: '/a-1' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.agenda.findUnique.mockResolvedValueOnce({ id: 'a-1', branchId: 'b-1' });
    mockedPrisma.agenda.delete.mockResolvedValueOnce({});
    res = await app.inject({ method: 'DELETE', url: '/a-1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });
});
