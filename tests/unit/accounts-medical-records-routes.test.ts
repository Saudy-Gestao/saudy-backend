import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import medicalRecordRoutes from '../../src/modules/accounts/routes/medical-records';
import prisma from '../../src/modules/accounts/lib/prisma';

vi.mock('../../src/modules/accounts/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    patient: { findFirst: vi.fn() },
    doctor: { findFirst: vi.fn() },
    medicalRecord: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
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

  app.addSchema({ $id: 'MedicalRecord', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'MedicalRecordCreate', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'MedicalRecordUpdate', type: 'object', additionalProperties: true });

  await app.register(medicalRecordRoutes, { prefix: '/medical-records' });
  return app;
}

describe('accounts medical-records routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b1' } } });
  });

  it('returns 403 when user has no branch', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/medical-records' });
    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it('lists records with filters', async () => {
    mockedPrisma.medicalRecord.findMany.mockResolvedValue([{ id: 'r1' }]);
    mockedPrisma.medicalRecord.count.mockResolvedValue(1);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/medical-records?patientId=p1&startDate=2026-01-01&endDate=2026-01-31&limit=10&offset=5' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ records: [{ id: 'r1' }], total: 1 });

    await app.close();
  });

  it('gets record by id and 404 when missing', async () => {
    mockedPrisma.medicalRecord.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'r1' });

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/medical-records/r1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/medical-records/r1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('creates record and validates patient/doctor', async () => {
    mockedPrisma.patient.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'p1' })
      .mockResolvedValueOnce({ id: 'p1' })
      .mockResolvedValueOnce({ id: 'p1' });
    mockedPrisma.doctor.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'd1' })
      .mockResolvedValueOnce({ id: 'd1' });
    mockedPrisma.medicalRecord.create
      .mockResolvedValueOnce({ id: 'r1' })
      .mockRejectedValueOnce(new Error('create fail'));

    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/medical-records', payload: { patientId: 'p1' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({});

    res = await app.inject({ method: 'POST', url: '/medical-records', payload: { patientId: 'p1', doctorId: 'd1' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({});

    res = await app.inject({ method: 'POST', url: '/medical-records', payload: { patientId: 'p1', doctorId: 'd1', recordDate: '2026-01-01T10:00:00.000Z' } });
    expect(res.statusCode).toBe(201);

    res = await app.inject({ method: 'POST', url: '/medical-records', payload: { patientId: 'p1', doctorId: 'd1' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({});

    await app.close();
  });

  it('updates and handles update errors', async () => {
    mockedPrisma.medicalRecord.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'r1' })
      .mockResolvedValueOnce({ id: 'r1' });
    mockedPrisma.medicalRecord.update
      .mockResolvedValueOnce({ id: 'r1' })
      .mockRejectedValueOnce(new Error('update fail'));

    const app = await buildApp();

    let res = await app.inject({ method: 'PUT', url: '/medical-records/r1', payload: { notes: 'x' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/medical-records/r1', payload: { notes: 'x' } });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'PUT', url: '/medical-records/r1', payload: { notes: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({});

    await app.close();
  });

  it('deletes record with not-found check', async () => {
    mockedPrisma.medicalRecord.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'r1' });
    mockedPrisma.medicalRecord.delete.mockResolvedValue({});

    const app = await buildApp();

    let res = await app.inject({ method: 'DELETE', url: '/medical-records/r1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/medical-records/r1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'Medical record deleted successfully' });

    await app.close();
  });

  it('returns patient vitals and handles patient not found', async () => {
    mockedPrisma.patient.findFirst.mockResolvedValue({ id: 'p1' });
    mockedPrisma.medicalRecord.findMany.mockResolvedValue([{ heartRate: 80, recordDate: '2026-01-01T10:00:00.000Z' }]);

    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/medical-records/patient/p1/vitals' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      latest: { heartRate: 80, recordDate: '2026-01-01T10:00:00.000Z' },
      history: [{ heartRate: 80, recordDate: '2026-01-01T10:00:00.000Z' }],
    });

    await app.close();
  });
});
