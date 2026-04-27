import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import reportWorklistRoutes from '../../src/modules/care/routes/report-worklist';
import prisma from '../../src/modules/care/lib/prisma';

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    reportWorklistItem: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    appointment: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    reportAddendum: {
      groupBy: vi.fn(),
      count: vi.fn(),
    },
  },
}));

const mockedPrisma = prisma as any;

async function buildApp(opts?: { unauthorized?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1' };
  });

  await app.register(reportWorklistRoutes, { prefix: '/report-worklist' });
  return app;
}

describe('care report-worklist routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b-1' } } });
  });

  it('handles auth and list', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/report-worklist' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    const app = await buildApp();
    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/report-worklist' });
    expect(res.statusCode).toBe(403);

    mockedPrisma.reportWorklistItem.findMany.mockResolvedValue([
      { id: 'w-1', appointmentId: 'a-1', patientName: 'Maria', patientCpf: '123', examType: 'TC', scheduledAt: '2026-01-01', convenio: 'U', requestingDoctor: 'Dr', status: 'rascunho' },
    ]);
    mockedPrisma.reportWorklistItem.count.mockResolvedValue(1);
    mockedPrisma.appointment.findMany.mockResolvedValue([
      { id: 'a-1', patientName: 'Maria', patientCpf: '123', specialty: 'TC', date: '2026-01-01', time: '10:00', convenio: 'U', doctorName: 'Dr', status: 'agendado', branchId: 'b-1', isActive: true },
    ]);
    mockedPrisma.reportAddendum.groupBy.mockResolvedValue([{ worklistItemId: 'w-1', _count: { _all: 1 } }]);

    res = await app.inject({ method: 'GET', url: '/report-worklist?search=maria&status=rascunho&examType=TC' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].hasFinalizedAddendum).toBe(true);

    await app.close();
  });

  it('gets item by id and handles not found', async () => {
    mockedPrisma.reportWorklistItem.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'w-1', appointmentId: null, patientName: 'Maria', patientCpf: '123', examType: 'TC', scheduledAt: '2026-01-01', convenio: null, requestingDoctor: null });
    mockedPrisma.reportAddendum.count.mockResolvedValue(0);

    const app = await buildApp();
    let res = await app.inject({ method: 'GET', url: '/report-worklist/w-1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/report-worklist/w-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('w-1');

    await app.close();
  });

  it('creates item with validations and upsert-by-appointment behavior', async () => {
    mockedPrisma.appointment.findFirst
      .mockResolvedValue({
        id: 'a-1',
        patientName: 'Maria',
        patientCpf: '123',
        specialty: 'TC',
        date: '2026-01-01',
        time: '10:00',
        convenio: 'U',
        doctorName: 'Dr',
        status: 'agendado',
        branchId: 'b-1',
        isActive: true,
      });
    mockedPrisma.reportWorklistItem.findFirst.mockResolvedValueOnce({ id: 'w-existing' });
    mockedPrisma.reportWorklistItem.create
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: 'w-1', appointmentId: null, patientName: 'Maria', patientCpf: '123', examType: 'TC', scheduledAt: null, convenio: null, requestingDoctor: null });
    mockedPrisma.reportWorklistItem.update.mockResolvedValue({ id: 'w-existing', appointmentId: 'a-1', patientName: 'Maria', patientCpf: '123', examType: 'TC', scheduledAt: '2026-01-01 10:00', convenio: 'U', requestingDoctor: 'Dr' });
    mockedPrisma.appointment.findUnique.mockResolvedValue({ id: 'a-1', patientName: 'Maria', patientCpf: '123', specialty: 'TC', date: '2026-01-01', time: '10:00', convenio: 'U', doctorName: 'Dr', status: 'agendado', branchId: 'b-1', isActive: true });

    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/report-worklist', payload: { patientName: 'x', examType: 'TC' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/report-worklist', payload: { patientCpf: '123', examType: 'TC' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/report-worklist', payload: { patientCpf: '123', patientName: 'Maria' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/report-worklist', payload: { patientCpf: '123', patientName: 'Maria', examType: 'TC' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/report-worklist', payload: { patientCpf: '123', patientName: 'Maria', examType: 'TC' } });
    expect(res.statusCode).toBe(201);

    res = await app.inject({ method: 'POST', url: '/report-worklist', payload: { appointmentId: 'a-1' } });
    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it('updates item and blocks unfinalize with finalized addendum', async () => {
    mockedPrisma.reportWorklistItem.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'w-1', status: 'finalizado', appointmentId: null, patientName: 'Maria', patientCpf: '123', examType: 'TC', scheduledAt: null, convenio: null, requestingDoctor: null })
      .mockResolvedValueOnce({ id: 'w-1', status: 'finalizado', appointmentId: null, patientName: 'Maria', patientCpf: '123', examType: 'TC', scheduledAt: null, convenio: null, requestingDoctor: null })
      .mockResolvedValueOnce({ id: 'w-1', status: 'rascunho', appointmentId: null, patientName: 'Maria', patientCpf: '123', examType: 'TC', scheduledAt: null, convenio: null, requestingDoctor: null });
    mockedPrisma.reportAddendum.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockedPrisma.reportWorklistItem.update.mockResolvedValueOnce({ id: 'w-1', appointmentId: null, patientName: 'Maria', patientCpf: '123', examType: 'TC', scheduledAt: null, convenio: null, requestingDoctor: null });

    const app = await buildApp();

    let res = await app.inject({ method: 'PUT', url: '/report-worklist/w-1', payload: { status: 'rascunho' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/report-worklist/w-1', payload: { status: 'rascunho' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PUT', url: '/report-worklist/w-1', payload: { status: 'rascunho' } });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'PUT', url: '/report-worklist/w-1', payload: { appointmentId: 'invalid' } });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('deletes item and handles not found', async () => {
    mockedPrisma.reportWorklistItem.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'w-1' });
    mockedPrisma.reportWorklistItem.delete.mockResolvedValue({});

    const app = await buildApp();

    let res = await app.inject({ method: 'DELETE', url: '/report-worklist/w-1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/report-worklist/w-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'Deleted' });

    await app.close();
  });
});
