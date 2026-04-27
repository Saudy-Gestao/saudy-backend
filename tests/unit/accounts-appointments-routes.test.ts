import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import appointmentRoutes from '../../src/modules/accounts/routes/appointments';
import prisma from '../../src/modules/accounts/lib/prisma';
import { publishAppointmentCreatedEvent } from '../../src/modules/care/lib/appointment-whatsapp-events';

vi.mock('../../src/modules/accounts/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    patient: { findFirst: vi.fn() },
    doctor: { findFirst: vi.fn() },
    appointment: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      groupBy: vi.fn(),
    },
  },
}));

vi.mock('../../src/modules/care/lib/appointment-whatsapp-events', () => ({
  publishAppointmentCreatedEvent: vi.fn(),
}));

const mockedPrisma = prisma as any;
const mockedPublishAppointmentCreatedEvent = publishAppointmentCreatedEvent as any;

async function buildApp() {
  const app = Fastify();
  app.decorateRequest('jwtVerify', async function jwtVerify() {});
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    (request as any).user = { id: 'u-1' };
  });

  app.addSchema({ $id: 'Appointment', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'AppointmentCreate', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'AppointmentUpdate', type: 'object', additionalProperties: true });

  await app.register(appointmentRoutes, { prefix: '/appointments' });
  return app;
}

describe('accounts appointments routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b1' } } });
  });

  it('returns 403 when logged user has no branch association', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/appointments' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'User not associated with a branch' });
    await app.close();
  });

  it('lists appointments with filters', async () => {
    mockedPrisma.appointment.findMany.mockResolvedValue([{ id: 'a1' }]);
    mockedPrisma.appointment.count.mockResolvedValue(1);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/appointments?doctorId=d1&patientId=p1&status=SCHEDULED&type=CONSULTATION&startDate=2026-01-01&endDate=2026-01-31&limit=10&offset=5',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ appointments: [{ id: 'a1' }], total: 1 });
    expect(mockedPrisma.appointment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 10,
      skip: 5,
      where: expect.objectContaining({ branchId: 'b1', doctorId: 'd1', patientId: 'p1' }),
    }));
    await app.close();
  });

  it('gets appointment by id and returns 404 when missing', async () => {
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'a1' });

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/appointments/a1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/appointments/a1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 'a1' });

    await app.close();
  });

  it('creates appointment and publishes created event', async () => {
    mockedPrisma.patient.findFirst.mockResolvedValue({ id: 'p1' });
    mockedPrisma.doctor.findFirst.mockResolvedValue({ id: 'd1' });
    mockedPrisma.appointment.findFirst.mockResolvedValue(null);
    mockedPrisma.appointment.create.mockResolvedValue({ id: 'a1' });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/appointments',
      payload: {
        patientId: 'p1',
        doctorId: 'd1',
        scheduledAt: '2026-02-01T10:00:00.000Z',
        duration: 45,
        type: 'CONSULTATION',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockedPrisma.appointment.create).toHaveBeenCalled();
    expect(mockedPublishAppointmentCreatedEvent).toHaveBeenCalledWith({ branchId: 'b1', appointmentId: 'a1' });

    await app.close();
  });

  it('validates create with missing patient/doctor, conflicts and prisma errors', async () => {
    const app = await buildApp();

    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'POST', url: '/appointments', payload: { patientId: 'p1', doctorId: 'd1', scheduledAt: '2026-01-01T10:00:00.000Z' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({});

    mockedPrisma.patient.findFirst.mockResolvedValueOnce({ id: 'p1' });
    mockedPrisma.doctor.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'POST', url: '/appointments', payload: { patientId: 'p1', doctorId: 'd1', scheduledAt: '2026-01-01T10:00:00.000Z' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({});

    mockedPrisma.patient.findFirst.mockResolvedValueOnce({ id: 'p1' });
    mockedPrisma.doctor.findFirst.mockResolvedValueOnce({ id: 'd1' });
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({ id: 'a-conflict' });
    res = await app.inject({ method: 'POST', url: '/appointments', payload: { patientId: 'p1', doctorId: 'd1', scheduledAt: '2026-01-01T10:00:00.000Z' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({});

    mockedPrisma.patient.findFirst.mockResolvedValueOnce({ id: 'p1' });
    mockedPrisma.doctor.findFirst.mockResolvedValueOnce({ id: 'd1' });
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.appointment.create.mockRejectedValueOnce(new Error('db fail'));
    res = await app.inject({ method: 'POST', url: '/appointments', payload: { patientId: 'p1', doctorId: 'd1', scheduledAt: '2026-01-01T10:00:00.000Z' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({});

    await app.close();
  });

  it('updates appointment status transitions and handles errors', async () => {
    mockedPrisma.appointment.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'a1', status: 'SCHEDULED' })
      .mockResolvedValueOnce({ id: 'a1', status: 'SCHEDULED' })
      .mockResolvedValueOnce({ id: 'a1', status: 'SCHEDULED' });

    mockedPrisma.appointment.update
      .mockResolvedValueOnce({ id: 'a1' })
      .mockResolvedValueOnce({ id: 'a1' })
      .mockRejectedValueOnce(new Error('bad update'));

    const app = await buildApp();

    let res = await app.inject({ method: 'PUT', url: '/appointments/a1', payload: { status: 'CONFIRMED' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/appointments/a1', payload: { status: 'CONFIRMED' } });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'PUT', url: '/appointments/a1', payload: { status: 'COMPLETED', scheduledAt: '2026-01-01T10:00:00.000Z' } });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'PUT', url: '/appointments/a1', payload: { status: 'CANCELED' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({});

    await app.close();
  });

  it('cancels appointment with validations', async () => {
    mockedPrisma.appointment.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'a1', status: 'CANCELED' })
      .mockResolvedValueOnce({ id: 'a1', status: 'COMPLETED' })
      .mockResolvedValueOnce({ id: 'a1', status: 'SCHEDULED' });
    mockedPrisma.appointment.update.mockResolvedValue({ id: 'a1', status: 'CANCELED' });

    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/appointments/a1/cancel', payload: { reason: 'x' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'POST', url: '/appointments/a1/cancel', payload: { reason: 'x' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/appointments/a1/cancel', payload: { reason: 'x' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/appointments/a1/cancel', payload: { reason: 'x' } });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('confirms appointment with validations', async () => {
    mockedPrisma.appointment.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'a1', status: 'COMPLETED' })
      .mockResolvedValueOnce({ id: 'a1', status: 'SCHEDULED' });
    mockedPrisma.appointment.update.mockResolvedValue({ id: 'a1', status: 'CONFIRMED' });

    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/appointments/a1/confirm' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'POST', url: '/appointments/a1/confirm' });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/appointments/a1/confirm' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('deletes appointment with validations', async () => {
    mockedPrisma.appointment.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'a1', medicalRecord: { id: 'mr1' } })
      .mockResolvedValueOnce({ id: 'a1', medicalRecord: null });
    mockedPrisma.appointment.delete.mockResolvedValue({});

    const app = await buildApp();

    let res = await app.inject({ method: 'DELETE', url: '/appointments/a1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/appointments/a1' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({});

    res = await app.inject({ method: 'DELETE', url: '/appointments/a1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'Appointment deleted successfully' });

    await app.close();
  });

  it('returns today appointments and stats overview', async () => {
    mockedPrisma.appointment.findMany.mockResolvedValue([{ id: 'a-today' }]);
    mockedPrisma.appointment.count.mockResolvedValue(3);
    mockedPrisma.appointment.groupBy
      .mockResolvedValueOnce([{ status: 'SCHEDULED', _count: { status: 2 } }])
      .mockResolvedValueOnce([{ type: 'CONSULTATION', _count: { type: 3 } }]);

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/appointments/today/all' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: 'a-today' }]);

    res = await app.inject({ method: 'GET', url: '/appointments/stats/overview?startDate=2026-01-01&endDate=2026-01-31' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      total: 3,
      byStatus: [{ status: 'SCHEDULED', count: 2 }],
      byType: [{ type: 'CONSULTATION', count: 3 }],
    });

    await app.close();
  });
});
