import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import publicCheckInRoutes from '../../src/modules/care/routes/public-check-in';
import prisma from '../../src/modules/care/lib/prisma';

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    branch: { findUnique: vi.fn() },
    patient: { findFirst: vi.fn() },
    appointment: { findMany: vi.fn() },
    preAttendance: { findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
    preSchedulingFlow: { findMany: vi.fn() },
    doctor: { findMany: vi.fn() },
  },
}));

const mockedPrisma = prisma as any;

async function buildApp(opts?: { unauthorized?: boolean; admHubOnly?: boolean; noCompany?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = {
      id: 'u-1',
      companyId: opts?.noCompany ? null : 'c-1',
      admHubOnly: !!opts?.admHubOnly,
    };
  });

  mockedPrisma.user.findUnique.mockResolvedValue(
    opts?.noCompany ? { id: 'u-1', sector: null } : { id: 'u-1', sector: { branch: { companyId: 'c-1' } } },
  );

  await app.register(publicCheckInRoutes, { prefix: '/pci' });
  return app;
}

describe('care public-check-in routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockedPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', sector: { branch: { companyId: 'c-1' } } });
    mockedPrisma.branch.findUnique.mockResolvedValue({
      id: 'b-1',
      tradeName: 'Filial A',
      phone: '1133334444',
      companyId: 'c-1',
      settings: { publicCheckInEnabled: true },
    });

    mockedPrisma.patient.findFirst.mockResolvedValue({
      id: 'p-1',
      name: 'Maria',
      cpf: '11144477735',
      birthDate: new Date('1990-01-01T00:00:00Z'),
      gender: 'F',
      phone: '1133334444',
      cellphone: '11999998888',
      email: 'maria@test.com',
      address: 'Rua 1',
      healthInsuranceName: 'Plano A',
      healthInsuranceNumber: 'ABC',
      healthInsuranceExpiry: new Date('2030-01-01T00:00:00Z'),
    });

    mockedPrisma.appointment.findMany.mockResolvedValue([
      {
        id: 'a-1',
        branchId: 'b-1',
        patientId: 'p-1',
        isActive: true,
        status: 'CONFIRMADO',
        date: '2026-04-13',
        time: '10:00',
        doctorName: 'Dr A',
        specialty: 'Cardio',
        convenio: 'Plano A',
        type: 'CONSULTA',
        authorizationStatus: 'AUTHORIZED',
      },
    ]);

    mockedPrisma.preAttendance.findMany.mockResolvedValue([]);
    mockedPrisma.preAttendance.create.mockResolvedValue({ id: 'pa-1', status: 'Na fila da recepção', appointmentId: 'a-1', queue: 'Fila de atendimento', queueType: 'Autorização e Recepção', agenda: '10:00 • Cardio • Dr A', doctorId: null, doctorName: 'Dr A' });
    mockedPrisma.preAttendance.update.mockResolvedValue({ id: 'pa-1', status: 'Na fila da recepção', appointmentId: 'a-1', queue: 'Fila de atendimento', queueType: 'Autorização e Recepção', agenda: '10:00 • Cardio • Dr A', doctorId: null, doctorName: 'Dr A' });

    mockedPrisma.preSchedulingFlow.findMany.mockResolvedValue([]);
    mockedPrisma.doctor.findMany.mockResolvedValue([]);
  });

  it('enforces auth and branch authorization', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/pci/branch/b-1' });
    expect(res.statusCode).toBe(500);
    await unauth.close();

    const app = await buildApp({ admHubOnly: true });
    res = await app.inject({ method: 'GET', url: '/pci/branch/b-1' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('returns branch info when authorized', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/pci/branch/b-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('b-1');
    await app.close();
  });

  it('validates facial payload and disabled mode', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/pci/facial', payload: {} });
    expect(res.statusCode).toBe(400);

    mockedPrisma.branch.findUnique.mockResolvedValueOnce({
      id: 'b-1',
      tradeName: 'Filial A',
      phone: '1133334444',
      companyId: 'c-1',
      settings: { publicCheckInEnabled: false },
    });
    res = await app.inject({ method: 'POST', url: '/pci/facial', payload: { branchId: 'b-1', patientCpf: '11144477735' } });
    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it('handles patient not found and no confirmed appointments', async () => {
    const app = await buildApp();

    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'POST', url: '/pci/facial', payload: { branchId: 'b-1', patientCpf: '11144477735' } });
    expect(res.statusCode).toBe(404);

    mockedPrisma.appointment.findMany.mockResolvedValueOnce([
      { id: 'a-1', status: 'PENDING', date: '2026-04-13', time: '10:00', doctorName: 'Dr A', specialty: 'Cardio', convenio: 'Plano A', type: 'CONSULTA' },
    ]);
    res = await app.inject({ method: 'POST', url: '/pci/facial', payload: { branchId: 'b-1', patientCpf: '11144477735' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('NO_CONFIRMED_APPOINTMENTS');

    await app.close();
  });

  it('creates or updates pre-attendance queue for confirmed appointments', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/pci/facial', payload: { branchId: 'b-1', patientCpf: '11144477735', trust: 0.91, totem: 2 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('QUEUED');

    mockedPrisma.preAttendance.findMany.mockResolvedValueOnce([
      { id: 'pa-1', appointmentId: 'a-1', status: 'Na fila da recepção', totem: 1 },
    ]);
    res = await app.inject({ method: 'POST', url: '/pci/facial', payload: { branchId: 'b-1', patientCpf: '11144477735' } });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('covers allAlreadyAdvanced message and plural queue message', async () => {
    const app = await buildApp();

    // allAlreadyAdvanced=true: existing preAttendance already in an ADVANCED status
    mockedPrisma.preAttendance.findMany.mockResolvedValueOnce([
      { id: 'pa-1', appointmentId: 'a-1', status: 'EM ATENDIMENTO NA RECEPCAO', totem: 1 },
    ]);
    let res = await app.inject({ method: 'POST', url: '/pci/facial', payload: { branchId: 'b-1', patientCpf: '11144477735' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toContain('já avançaram');

    // queuedPreAttendances.length > 1: 2 confirmed appointments, both queued → plural message
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([
      { id: 'a-1', branchId: 'b-1', patientId: 'p-1', isActive: true, status: 'CONFIRMADO', date: '2026-04-13', time: '10:00', doctorName: 'Dr A', specialty: 'Cardio', convenio: 'Plano A', type: 'CONSULTA', authorizationStatus: null },
      { id: 'a-2', branchId: 'b-1', patientId: 'p-1', isActive: true, status: 'CONFIRMADO', date: '2026-04-13', time: '11:00', doctorName: 'Dr B', specialty: 'Ortho', convenio: 'Plano B', type: 'CONSULTA', authorizationStatus: null },
    ]);
    mockedPrisma.preAttendance.create
      .mockResolvedValueOnce({ id: 'pa-1', status: 'Na fila da recepção', appointmentId: 'a-1' })
      .mockResolvedValueOnce({ id: 'pa-2', status: 'Na fila da recepção', appointmentId: 'a-2' });
    res = await app.inject({ method: 'POST', url: '/pci/facial', payload: { branchId: 'b-1', patientCpf: '11144477735' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toContain('2 agendamentos');

    await app.close();
  });

  it('covers no-patientId/no-cpf 400 and trust/doctorName omitted branches', async () => {
    const app = await buildApp();

    // no patientId and no patientCpf → patientLookupConditions empty → 400 (lines 301-305)
    let res = await app.inject({ method: 'POST', url: '/pci/facial', payload: { branchId: 'b-1' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().status).toBe('PATIENT_NOT_FOUND');

    // appointment with null doctorName + trust undefined → covers lines 398 (trust undef→null) and 430 (empty doctorNames → [])
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([
      { id: 'a-1', branchId: 'b-1', patientId: 'p-1', isActive: true, status: 'CONFIRMADO',
        date: '2026-04-13', time: '10:00', doctorName: null, specialty: 'Cardio',
        convenio: 'Plano A', type: 'CONSULTA', authorizationStatus: null },
    ]);
    mockedPrisma.preAttendance.create.mockResolvedValueOnce({ id: 'pa-1', status: 'Na fila da recepção', appointmentId: 'a-1' });
    res = await app.inject({ method: 'POST', url: '/pci/facial', payload: { branchId: 'b-1', patientCpf: '11144477735' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('QUEUED');

    await app.close();
  });

  it('covers queue status branches for same-day delayed and future appointments', async () => {
    const app = await buildApp();

    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    // Same day + very early time -> delayedAt stays today and now > delayedTime (covers line 141 branch)
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([
      {
        id: 'a-1',
        branchId: 'b-1',
        patientId: 'p-1',
        isActive: true,
        status: 'CONFIRMADO',
        date: today,
        time: '00:00',
        doctorName: 'Dr A',
        specialty: 'Cardio',
        convenio: 'Plano A',
        type: 'CONSULTA',
        authorizationStatus: null,
      },
    ]);
    let res = await app.inject({ method: 'POST', url: '/pci/facial', payload: { branchId: 'b-1', patientCpf: '11144477735' } });
    expect(res.statusCode).toBe(200);

    // Future date -> not delayed (covers fallback return branch at lines 146-147)
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([
      {
        id: 'a-1',
        branchId: 'b-1',
        patientId: 'p-1',
        isActive: true,
        status: 'CONFIRMADO',
        date: '2099-01-01',
        time: '10:00',
        doctorName: 'Dr A',
        specialty: 'Cardio',
        convenio: 'Plano A',
        type: 'CONSULTA',
        authorizationStatus: null,
      },
    ]);
    res = await app.inject({ method: 'POST', url: '/pci/facial', payload: { branchId: 'b-1', patientCpf: '11144477735' } });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('covers facial branch required and unauthorized branch access', async () => {
    const app = await buildApp();

    // branchId empty string reaches route-level guard
    let res = await app.inject({ method: 'POST', url: '/pci/facial', payload: { branchId: '', patientCpf: '11144477735' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('branchId is required');
    await app.close();

    // companyId cannot be resolved -> unauthorized branch context in facial route
    const noCompany = await buildApp({ noCompany: true });
    res = await noCompany.inject({ method: 'POST', url: '/pci/facial', payload: { branchId: 'b-1', patientCpf: '11144477735' } });
    expect(res.statusCode).toBe(403);
    await noCompany.close();

    // branch exists but belongs to another company -> unauthorized (getAuthorizedBranchContext returns null)
    const appOtherCompany = await buildApp();
    mockedPrisma.branch.findUnique.mockResolvedValueOnce({
      id: 'b-1',
      tradeName: 'Filial B',
      phone: '1133334444',
      companyId: 'other-company',
      settings: { publicCheckInEnabled: true },
    });
    res = await appOtherCompany.inject({ method: 'POST', url: '/pci/facial', payload: { branchId: 'b-1', patientCpf: '11144477735' } });
    expect(res.statusCode).toBe(403);
    await appOtherCompany.close();
  });
});
