import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import patientRoutes from '../../src/modules/accounts/routes/patients';
import prisma from '../../src/modules/accounts/lib/prisma';

vi.mock('../../src/modules/accounts/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    patient: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      groupBy: vi.fn(),
    },
    appointment: { count: vi.fn() },
    medicalRecord: { count: vi.fn(), findMany: vi.fn() },
  },
}));

const mockedPrisma = prisma as any;

async function buildApp() {
  const app = Fastify();
  app.decorateRequest('jwtVerify', async function jwtVerify() {});
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    (request as any).user = { id: 'u-1' };
  });

  app.addSchema({ $id: 'Patient', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'PatientUpdate', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'MedicalRecord', type: 'object', additionalProperties: true });

  await app.register(patientRoutes, { prefix: '/patients' });
  return app;
}

describe('accounts patients routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b1', companyId: 'c1' } } });
  });

  it('returns 403 when user has no branch', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/patients' });
    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it('lists patients with filters', async () => {
    mockedPrisma.patient.findMany.mockResolvedValue([{ id: 'p1' }]);
    mockedPrisma.patient.count.mockResolvedValue(1);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/patients?isActive=true&hasHealthInsurance=false&search=maria&limit=10&offset=2',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ patients: [{ id: 'p1' }], total: 1 });

    await app.close();
  });

  it('gets patient by id and cpf', async () => {
    mockedPrisma.patient.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'p1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'p1' });

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/patients/p1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/patients/p1' });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: '/patients/cpf/123' });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'GET', url: '/patients/cpf/529.982.247-25' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/patients/cpf/52998224725' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('validates create payload and creates patient', async () => {
    mockedPrisma.patient.create.mockResolvedValue({ id: 'p1' });

    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/patients', payload: {} });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/patients',
      payload: {
        name: '',
        cpf: '1',
        birthDate: '3000-01-01',
        gender: 'X',
        email: 'bad',
        hasHealthInsurance: true,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Validation failed');

    res = await app.inject({
      method: 'POST',
      url: '/patients',
      payload: {
        name: 'Maria',
        cpf: '529.982.247-25',
        birthDate: '1990-01-01',
        gender: 'female',
        cellphone: '11999999999',
        email: 'maria@mail.com',
      },
    });
    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it('handles create unique and generic errors', async () => {
    mockedPrisma.patient.create
      .mockRejectedValueOnce({ code: 'P2002', meta: { target: ['cpf'] } })
      .mockRejectedValueOnce(new Error('boom'));

    const app = await buildApp();
    const payload = {
      name: 'Maria', cpf: '52998224725', birthDate: '1990-01-01', cellphone: '11999999999', email: 'maria@mail.com',
    };

    let res = await app.inject({ method: 'POST', url: '/patients', payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Validation failed');

    res = await app.inject({ method: 'POST', url: '/patients', payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Failed to create patient');

    await app.close();
  });

  it('updates patient with validations and date conversions', async () => {
    mockedPrisma.patient.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'p1', branchId: 'b1' });
    mockedPrisma.patient.update.mockResolvedValue({ id: 'p1' });

    const app = await buildApp();

    let res = await app.inject({ method: 'PUT', url: '/patients/p1', payload: { email: 'x' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/patients/p1', payload: { cpf: '1' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PUT', url: '/patients/p1', payload: { birthDate: 'invalid' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PUT', url: '/patients/p1', payload: { birthDate: '1990-01-01', healthInsuranceExpiry: '2027-01-01', gender: 'male' } });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('handles update invalid healthInsuranceExpiry and errors', async () => {
    mockedPrisma.patient.findFirst.mockResolvedValue({ id: 'p1' });

    const app = await buildApp();

    let res = await app.inject({ method: 'PUT', url: '/patients/p1', payload: { healthInsuranceExpiry: 'invalid-date' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.patient.update.mockRejectedValueOnce({ code: 'P2002', meta: { target: ['email'] } });
    res = await app.inject({ method: 'PUT', url: '/patients/p1', payload: { email: 'm@mail.com' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.patient.update.mockRejectedValueOnce(new Error('bad update'));
    res = await app.inject({ method: 'PUT', url: '/patients/p1', payload: { email: 'm@mail.com' } });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('deletes patient with dependency checks', async () => {
    mockedPrisma.patient.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'p1' })
      .mockResolvedValueOnce({ id: 'p1' });
    mockedPrisma.appointment.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    mockedPrisma.medicalRecord.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    mockedPrisma.patient.delete.mockResolvedValue({});

    const app = await buildApp();

    let res = await app.inject({ method: 'DELETE', url: '/patients/p1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/patients/p1' });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'DELETE', url: '/patients/p1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('gets history and stats overview', async () => {
    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'p1' });
    mockedPrisma.medicalRecord.findMany.mockResolvedValue([{ id: 'm1' }]);

    mockedPrisma.patient.count
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(4);
    mockedPrisma.patient.groupBy.mockResolvedValue([{ gender: 'FEMALE', _count: { gender: 6 } }]);

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/patients/p1/history' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/patients/p1/history' });
    expect(res.statusCode).toBe(200);
    expect(res.json().medicalRecords).toEqual([{ id: 'm1' }]);

    res = await app.inject({ method: 'GET', url: '/patients/stats/overview' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      totalPatients: 10,
      activePatients: 8,
      withHealthInsurance: 4,
      withoutHealthInsurance: 6,
      byGender: [{ gender: 'FEMALE', count: 6 }],
    });

    await app.close();
  });
});
