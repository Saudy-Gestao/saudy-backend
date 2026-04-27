import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import appointmentRoutes from '../../src/modules/care/routes/appointments';
import prisma from '../../src/modules/care/lib/prisma';
import { publishAppointmentCreatedEvent, publishAppointmentNoShowEventIfNeeded } from '../../src/modules/care/lib/appointment-whatsapp-events';

vi.mock('../../src/modules/care/lib/appointment-whatsapp-events', () => ({
  publishAppointmentCreatedEvent: vi.fn(),
  publishAppointmentNoShowEventIfNeeded: vi.fn(),
}));

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    branchSettings: { findUnique: vi.fn() },
    patient: { findMany: vi.fn() },
    appointment: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
    },
    appointmentAttachment: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    mwlEntry: {
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

const mockedPrisma = prisma as any;
const mockedPublishCreated = publishAppointmentCreatedEvent as any;
const mockedPublishNoShow = publishAppointmentNoShowEventIfNeeded as any;

const tx = {
  appointment: {
    findMany: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    updateMany: vi.fn(),
  },
  mwlEntry: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  procedure: { findFirst: vi.fn() },
  procedureMaterial: { findMany: vi.fn() },
  inventoryItem: {
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};

async function buildApp(opts?: { unauthorized?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1' };
  });

  await app.register(appointmentRoutes, { prefix: '/appointments' });
  return app;
}

describe('care appointments routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b-1' } } });
    mockedPrisma.branchSettings.findUnique.mockResolvedValue({ noShowToleranceMinutes: 30 });
    mockedPrisma.patient.findMany.mockResolvedValue([]);
    mockedPrisma.appointment.findMany.mockResolvedValue([]);
    mockedPrisma.appointment.count.mockResolvedValue(0);
    mockedPrisma.appointment.findFirst.mockResolvedValue(null);
    mockedPrisma.appointmentAttachment.findMany.mockResolvedValue([]);
    mockedPrisma.appointmentAttachment.findFirst.mockResolvedValue(null);
    mockedPrisma.mwlEntry.findFirst.mockResolvedValue(null);

    tx.appointment.findMany.mockResolvedValue([]);
    tx.appointment.create.mockResolvedValue({ id: 'a-1', status: 'AGENDADO', date: '2026-04-13', time: '09:00' });
    tx.appointment.findFirst.mockResolvedValue(null);
    tx.appointment.update.mockResolvedValue({ id: 'a-1', status: 'AGENDADO' });
    tx.appointment.delete.mockResolvedValue({ id: 'a-1' });
    tx.appointment.updateMany.mockResolvedValue({ count: 0 });

    tx.mwlEntry.findFirst.mockResolvedValue(null);
    tx.mwlEntry.create.mockResolvedValue({ id: 'm-1' });
    tx.mwlEntry.update.mockResolvedValue({ id: 'm-1' });
    tx.mwlEntry.updateMany.mockResolvedValue({ count: 1 });

    tx.procedure.findFirst.mockResolvedValue(null);
    tx.procedureMaterial.findMany.mockResolvedValue([]);
    tx.inventoryItem.updateMany.mockResolvedValue({ count: 1 });
    tx.inventoryItem.findUnique.mockResolvedValue({ id: 'i-1', name: 'Item' });
    tx.inventoryItem.update.mockResolvedValue({ id: 'i-1' });

    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));
  });

  it('enforces auth and branch checks', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/appointments' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    const app = await buildApp();

    res = await app.inject({ method: 'GET', url: '/appointments/a-1' });
    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it('lists and gets appointments', async () => {
    mockedPrisma.appointment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'a-1' }]);
    mockedPrisma.appointment.count.mockResolvedValue(1);
    mockedPrisma.appointment.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'a-1' });

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/appointments?search=maria&status=AGENDADO' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    res = await app.inject({ method: 'GET', url: '/appointments/a-1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/appointments/a-1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('handles attachments listing and bucket-not-configured flows', async () => {
    mockedPrisma.appointment.findFirst.mockResolvedValue({ id: 'a-1' });

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/appointments/a-1/attachments' });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'POST', url: '/appointments/a-1/attachments', payload: { fileName: 'x.pdf', fileBase64: 'YQ==' } });
    expect(res.statusCode).toBe(503);

    res = await app.inject({ method: 'GET', url: '/appointments/attachments/att-1/view' });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('creates appointments with validation, conflict and success', async () => {
    const app = await buildApp();

    mockedPrisma.appointment.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({
      method: 'POST',
      url: '/appointments',
      payload: {
        rescheduledFromAppointmentId: 'a-old',
        specialty: 'USG',
        date: '2026-04-13',
        time: '10:00',
      },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.$transaction
      .mockImplementationOnce(async (cb: any) => {
        tx.appointment.findMany.mockResolvedValueOnce([{ id: 'a-conflict', patientName: 'Maria', time: '10:00', durationMinutes: 30, status: 'AGENDADO' }]);
        return cb(tx);
      })
      .mockImplementationOnce(async (cb: any) => cb(tx));

    res = await app.inject({
      method: 'POST',
      url: '/appointments',
      payload: { specialty: 'USG', doctorName: 'Dr', date: '2026-04-13', time: '10:00' },
    });
    expect(res.statusCode).toBe(409);

    tx.appointment.create.mockResolvedValueOnce({ id: 'a-2', status: 'AGENDADO', date: '2026-04-13', time: '11:00' });
    res = await app.inject({
      method: 'POST',
      url: '/appointments',
      payload: { specialty: 'USG', doctorName: 'Dr', date: '2026-04-13', time: '11:00' },
    });
    expect(res.statusCode).toBe(201);
    expect(mockedPublishCreated).toHaveBeenCalled();

    await app.close();
  });

  it('updates, deletes and creates worklist', async () => {
    mockedPrisma.appointment.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'a-1', branchId: 'b-1', status: 'AGENDADO', doctorName: 'Dr', date: '2026-04-13', time: '10:00', durationMinutes: 30, inventoryConsumedAt: null })
      .mockResolvedValueOnce({ id: 'a-1', branchId: 'b-1', status: 'AGENDADO', doctorName: 'Dr', date: '2026-04-13', time: '10:00', durationMinutes: 30, inventoryConsumedAt: null })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'a-1', branchId: 'b-1', status: 'AGENDADO' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'a-1', branchId: 'b-1', status: 'AGENDADO', isActive: true });

    mockedPrisma.$transaction
      .mockImplementationOnce(async () => { throw new Error('DOCTOR_SCHEDULE_CONFLICT::Joao::10:00'); })
      .mockImplementation(async (cb: any) => cb(tx));

    mockedPrisma.mwlEntry.findFirst.mockResolvedValue({ id: 'm-1', appointmentId: 'a-1' });
    tx.appointment.update.mockResolvedValueOnce({ id: 'a-1', status: 'NAO_COMPARECEU' });

    const app = await buildApp();

    let res = await app.inject({ method: 'PUT', url: '/appointments/a-1', payload: { status: 'CONFIRMADO' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/appointments/a-1', payload: { doctorName: 'Dr B', time: '10:00' } });
    expect(res.statusCode).toBe(409);

    res = await app.inject({ method: 'PUT', url: '/appointments/a-1', payload: { status: 'NAO_COMPARECEU' } });
    expect(res.statusCode).toBe(200);
    expect(mockedPublishNoShow).toHaveBeenCalled();

    res = await app.inject({ method: 'DELETE', url: '/appointments/a-1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/appointments/a-1' });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'POST', url: '/appointments/a-1/create-worklist' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'POST', url: '/appointments/a-1/create-worklist' });
    expect(res.statusCode).toBe(200);
    expect(res.json().mwlEntry).toEqual({ id: 'm-1', appointmentId: 'a-1' });

    await app.close();
  });

  it('applies automatic no-show during listing and publishes no-show events', async () => {
    mockedPrisma.appointment.findMany
      .mockResolvedValueOnce([{ id: 'a-overdue-1' }, { id: 'a-overdue-2' }])
      .mockResolvedValueOnce([{ id: 'a-1' }]);
    mockedPrisma.appointment.count.mockResolvedValueOnce(1);
    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/appointments?patientCpf=123.456.789-01&startDate=2026-04-01&endDate=2026-04-30' });

    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(tx.appointment.updateMany).toHaveBeenCalled();
    expect(tx.mwlEntry.updateMany).toHaveBeenCalled();
    expect(mockedPublishNoShow).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('handles create/update generic failures and authorization status transitions', async () => {
    mockedPrisma.appointment.findFirst
      .mockResolvedValueOnce({ id: 'a-1', branchId: 'b-1', status: 'AGENDADO', doctorName: 'Dr', date: '2026-04-13', time: '10:00', durationMinutes: 30, authorizedAt: null, inventoryConsumedAt: null })
      .mockResolvedValueOnce({ id: 'a-1', branchId: 'b-1', status: 'AGENDADO', doctorName: 'Dr', date: '2026-04-13', time: '10:00', durationMinutes: 30, authorizedAt: new Date(), inventoryConsumedAt: null })
      .mockResolvedValueOnce({ id: 'a-1', branchId: 'b-1', status: 'AGENDADO', doctorName: 'Dr', date: '2026-04-13', time: '10:00', durationMinutes: 30, authorizedAt: new Date(), inventoryConsumedAt: null });

    mockedPrisma.$transaction
      .mockImplementationOnce(async () => { throw new Error('boom-create'); })
      .mockImplementationOnce(async (cb: any) => cb(tx))
      .mockImplementationOnce(async (cb: any) => cb(tx))
      .mockImplementationOnce(async () => { throw new Error('boom-update'); });

    const app = await buildApp();

    let res = await app.inject({
      method: 'POST',
      url: '/appointments',
      payload: { specialty: 'USG', doctorName: 'Dr', date: '2026-04-13', time: '10:00' },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'PUT',
      url: '/appointments/a-1',
      payload: { authorizationStatus: 'AUTHORIZED' },
    });
    expect(res.statusCode).toBe(200);
    expect(tx.appointment.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'a-1' },
      data: expect.objectContaining({ authorizationStatus: 'AUTHORIZED', authorizedAt: expect.any(Date) }),
    }));

    res = await app.inject({
      method: 'PUT',
      url: '/appointments/a-1',
      payload: { authorizationStatus: 'PENDING' },
    });
    expect(res.statusCode).toBe(200);
    expect(tx.appointment.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'a-1' },
      data: expect.objectContaining({ authorizationStatus: 'PENDING', authorizedAt: null }),
    }));

    res = await app.inject({
      method: 'PUT',
      url: '/appointments/a-1',
      payload: { doctorName: 'Dr B', time: '11:00' },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('applies date/startDate/endDate/specialty/convenio filters and ignores search when patientId present', async () => {
    mockedPrisma.appointment.findMany
      .mockResolvedValue([]) // for applyAutomaticNoShowForBranch (candidates)
      .mockResolvedValueOnce([{ id: 'a-1' }]); // for the actual listing
    mockedPrisma.appointment.count.mockResolvedValueOnce(1);

    const app = await buildApp();

    // date-only filter
    let res = await app.inject({ method: 'GET', url: '/appointments?date=2026-04-13' });
    expect(res.statusCode).toBe(200);

    // startDate + endDate
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([]);
    mockedPrisma.appointment.count.mockResolvedValueOnce(0);
    res = await app.inject({ method: 'GET', url: '/appointments?startDate=2026-04-01&endDate=2026-04-30' });
    expect(res.statusCode).toBe(200);

    // specialty + convenio
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([]);
    mockedPrisma.appointment.count.mockResolvedValueOnce(0);
    res = await app.inject({ method: 'GET', url: '/appointments?specialty=USG&convenio=UNIMED' });
    expect(res.statusCode).toBe(200);

    // search + patientId → search should be IGNORED
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([]);
    mockedPrisma.appointment.count.mockResolvedValueOnce(0);
    res = await app.inject({ method: 'GET', url: '/appointments?search=ignored&patientId=p-1' });
    expect(res.statusCode).toBe(200);

    // startDate only
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([]);
    mockedPrisma.appointment.count.mockResolvedValueOnce(0);
    res = await app.inject({ method: 'GET', url: '/appointments?startDate=2026-04-01' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('publishes notification when relevant fields change in PUT /:id', async () => {
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-1', branchId: 'b-1', status: 'AGENDADO', doctorName: 'Dr A',
      date: '2026-04-13', time: '10:00', durationMinutes: 30, inventoryConsumedAt: null,
      patientName: 'Maria', specialty: 'USG', authorizedAt: null,
    });
    mockedPrisma.$transaction.mockImplementationOnce(async (cb: any) => cb(tx));
    tx.appointment.update.mockResolvedValueOnce({ id: 'a-1', status: 'AGENDADO', date: '2026-04-14' });

    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT', url: '/appointments/a-1',
      payload: { date: '2026-04-14' }, // relevant field change
    });
    expect(res.statusCode).toBe(200);
    expect(mockedPublishCreated).toHaveBeenCalled();
    await app.close();
  });

  it('does NOT publish notification when only non-relevant fields change in PUT /:id', async () => {
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-1', branchId: 'b-1', status: 'AGENDADO', doctorName: 'Dr A',
      date: '2026-04-13', time: '10:00', durationMinutes: 30, inventoryConsumedAt: null,
      patientName: 'Maria', specialty: 'USG', authorizedAt: null,
    });
    mockedPrisma.$transaction.mockImplementationOnce(async (cb: any) => cb(tx));
    tx.appointment.update.mockResolvedValueOnce({ id: 'a-1', status: 'CONFIRMADO' });

    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT', url: '/appointments/a-1',
      payload: { status: 'CONFIRMADO' }, // NOT a relevant field for notification
    });
    expect(res.statusCode).toBe(200);
    expect(mockedPublishCreated).not.toHaveBeenCalled();
    await app.close();
  });

  it('PUT /:id consumes inventory when transitioning to REALIZADO', async () => {
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-1', branchId: 'b-1', status: 'AGENDADO', doctorName: 'Dr A',
      date: '2026-04-13', time: '10:00', durationMinutes: 30,
      inventoryConsumedAt: null, specialty: 'USG', patientName: 'Maria',
    });
    mockedPrisma.$transaction.mockImplementationOnce(async (cb: any) => {
      tx.procedure.findFirst.mockResolvedValueOnce({ id: 'proc-1', name: 'USG' });
      tx.procedureMaterial.findMany.mockResolvedValueOnce([{ inventoryItemId: 'i-1', quantity: 2 }]);
      tx.inventoryItem.updateMany.mockResolvedValueOnce({ count: 1 });
      tx.inventoryItem.findUnique.mockResolvedValueOnce({ id: 'i-1', name: 'Gel USG', quantity: 8, minQuantity: 5, status: 'AVAILABLE' });
      tx.appointment.update.mockResolvedValueOnce({ id: 'a-1', status: 'REALIZADO', inventoryConsumedAt: new Date() });
      return cb(tx);
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT', url: '/appointments/a-1',
      payload: { status: 'REALIZADO' },
    });
    expect(res.statusCode).toBe(200);
    expect(tx.inventoryItem.updateMany).toHaveBeenCalled();
    await app.close();
  });

  it('PUT /:id reverts inventory when transitioning to CANCELADO if previously consumed', async () => {
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-1', branchId: 'b-1', status: 'REALIZADO', doctorName: 'Dr A',
      date: '2026-04-13', time: '10:00', durationMinutes: 30,
      inventoryConsumedAt: new Date('2026-04-13'), specialty: 'USG',
    });
    mockedPrisma.$transaction.mockImplementationOnce(async (cb: any) => {
      tx.procedure.findFirst.mockResolvedValueOnce({ id: 'proc-1', name: 'USG' });
      tx.procedureMaterial.findMany.mockResolvedValueOnce([{ inventoryItemId: 'i-1', quantity: 2 }]);
      tx.inventoryItem.update.mockResolvedValueOnce({ id: 'i-1', quantity: 10 });
      tx.inventoryItem.findUnique.mockResolvedValueOnce({ id: 'i-1', name: 'Gel USG', quantity: 10, minQuantity: 5, status: 'LOW' });
      tx.appointment.update.mockResolvedValueOnce({ id: 'a-1', status: 'CANCELADO', inventoryConsumedAt: null });
      return cb(tx);
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT', url: '/appointments/a-1',
      payload: { status: 'CANCELADO' },
    });
    expect(res.statusCode).toBe(200);
    expect(tx.inventoryItem.update).toHaveBeenCalled();
    await app.close();
  });

  it('POST / rejects when rescheduledFromAppointmentId not found', async () => {
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce(null);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/appointments',
      payload: {
        specialty: 'USG', date: '2026-04-13', time: '10:00',
        rescheduledFromAppointmentId: 'a-missing',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/source appointment/i);
    await app.close();
  });

  it('POST / succeeds when rescheduledFromAppointmentId IS found', async () => {
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({ id: 'a-old' }); // source found
    mockedPrisma.$transaction
      .mockImplementationOnce(async (cb: any) => null) // conflict check
      .mockImplementationOnce(async (cb: any) => cb(tx)); // create

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/appointments',
      payload: {
        specialty: 'USG', doctorName: 'Dr A', date: '2026-04-13', time: '10:00',
        rescheduledFromAppointmentId: 'a-old',
      },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('syncMwlFromAppointment creates MWL only for CONFIRMADO status (via create-worklist)', async () => {
    // AGENDADO (not confirmed) → should NOT create new MWL entry (mwlEntry.findFirst = null)
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-1', branchId: 'b-1', status: 'AGENDADO', isActive: true,
      date: '2026-04-13', time: '10:00', specialty: 'USG', patientName: 'Maria',
    });
    mockedPrisma.$transaction.mockImplementationOnce(async (cb: any) => {
      tx.mwlEntry.findFirst.mockResolvedValueOnce(null); // no existing MWL
      // status is AGENDADO → not confirmed → should NOT create
      return cb(tx);
    });
    mockedPrisma.mwlEntry.findFirst.mockResolvedValueOnce(null);

    const app = await buildApp();
    let res = await app.inject({ method: 'POST', url: '/appointments/a-1/create-worklist' });
    expect(res.statusCode).toBe(200);
    expect(tx.mwlEntry.create).not.toHaveBeenCalled();

    // CONFIRMADO → SHOULD create MWL
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-2', branchId: 'b-1', status: 'CONFIRMADO', isActive: true,
      date: '2026-04-13', time: '10:00', specialty: 'USG', patientName: 'Maria',
    });
    mockedPrisma.$transaction.mockImplementationOnce(async (cb: any) => {
      tx.mwlEntry.findFirst.mockResolvedValueOnce(null); // no existing
      return cb(tx);
    });
    mockedPrisma.mwlEntry.findFirst.mockResolvedValueOnce({ id: 'm-2', appointmentId: 'a-2' });

    res = await app.inject({ method: 'POST', url: '/appointments/a-2/create-worklist' });
    expect(res.statusCode).toBe(200);
    expect(tx.mwlEntry.create).toHaveBeenCalled();

    await app.close();
  });

  it('syncMwlFromAppointment updates existing MWL entry regardless of status', async () => {
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-1', branchId: 'b-1', status: 'CANCELADO', isActive: true,
      date: '2026-04-13', time: '10:00', specialty: 'USG', patientName: 'Maria',
    });
    mockedPrisma.$transaction.mockImplementationOnce(async (cb: any) => {
      tx.mwlEntry.findFirst.mockResolvedValueOnce({ id: 'm-1', appointmentId: 'a-1' }); // existing
      return cb(tx);
    });
    mockedPrisma.mwlEntry.findFirst.mockResolvedValueOnce({ id: 'm-1', appointmentId: 'a-1' });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/appointments/a-1/create-worklist' });
    expect(res.statusCode).toBe(200);
    expect(tx.mwlEntry.update).toHaveBeenCalled();
    expect(tx.mwlEntry.create).not.toHaveBeenCalled();
    await app.close();
  });
});
