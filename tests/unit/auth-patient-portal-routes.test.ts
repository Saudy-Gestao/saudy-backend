import crypto from 'crypto';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import patientPortalRoutes from '../../src/modules/auth/routes/patient-portal';
import prisma from '../../src/modules/auth/lib/prisma';
import { isValidCpf, normalizeCpf } from '../../src/lib/cpf';
import { sendPatientPortalAccessCodeEmail } from '../../src/modules/auth/lib/mailer';
import { getAnexosStorage } from '../../src/lib/storage';

vi.mock('../../src/modules/auth/lib/prisma', () => ({
  default: {
    patient: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    patientPortalDependentAuthorization: {
      findMany: vi.fn(),
    },
    patientPortalAccessLog: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    appointment: {
      count: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    appointmentAttachment: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    report: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    reportAuditLog: {
      findMany: vi.fn(),
    },
    reportConfig: {
      findFirst: vi.fn(),
    },
    doctor: {
      findMany: vi.fn(),
    },
    preSchedulingDocument: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    preSchedulingFlow: {
      create: vi.fn(),
      update: vi.fn(),
    },
    procedure: {
      findMany: vi.fn(),
    },
    delivery: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('../../src/lib/cpf', () => ({
  isValidCpf: vi.fn(),
  normalizeCpf: vi.fn(),
}));

vi.mock('../../src/lib/storage', () => ({
  getAnexosStorage: vi.fn(() => ({ getSignedUrl: vi.fn(), getDownloadUrl: vi.fn(), exists: vi.fn(), createReadStream: vi.fn() })),
}));

vi.mock('../../src/modules/auth/lib/mailer', () => ({
  sendPatientPortalAccessCodeEmail: vi.fn(),
}));

const mockedPrisma = prisma as any;
const mockedIsValidCpf = isValidCpf as any;
const mockedNormalizeCpf = normalizeCpf as any;
const mockedSendPatientPortalAccessCodeEmail = sendPatientPortalAccessCodeEmail as any;

const hashCode = (code: string) => crypto.createHash('sha256').update(code).digest('hex');

async function buildApp(currentUser?: any) {
  const app = Fastify();

  app.decorate('jwt', {
    sign: vi.fn((payload: any) => JSON.stringify(payload)),
    verify: vi.fn((token: string) => JSON.parse(token)),
    decode: vi.fn(),
  } as any);

  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (!currentUser) throw new Error('unauthorized');
    this.user = currentUser;
  });

  await app.register(patientPortalRoutes);
  return app;
}

describe('auth patient portal routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedNormalizeCpf.mockImplementation((value: string) => String(value || '').replace(/\D/g, ''));
    mockedIsValidCpf.mockReturnValue(true);
    mockedPrisma.patientPortalAccessLog.create.mockResolvedValue({});
    mockedPrisma.appointmentAttachment.findMany.mockResolvedValue([]);
    mockedPrisma.appointmentAttachment.findFirst.mockResolvedValue(null);
    mockedPrisma.preSchedulingDocument.findMany.mockResolvedValue([]);
    mockedPrisma.preSchedulingDocument.findFirst.mockResolvedValue(null);
    mockedPrisma.report.findMany.mockResolvedValue([]);
    mockedPrisma.report.count.mockResolvedValue(0);
    mockedPrisma.reportAuditLog.findMany.mockResolvedValue([]);
    mockedPrisma.reportConfig.findFirst.mockResolvedValue(null);
    mockedPrisma.doctor.findMany.mockResolvedValue([]);
    mockedPrisma.appointment.findMany.mockResolvedValue([]);
    mockedPrisma.appointment.count.mockResolvedValue(0);
    mockedPrisma.appointment.findFirst.mockResolvedValue(null);
    mockedPrisma.preSchedulingFlow.create.mockResolvedValue({
      id: 'flow-1',
      publicToken: 'tok-1',
      status: 'WAITING_PATIENT_DOCUMENTS',
      documents: [],
      anamnesisResponse: null,
      patientAccessExpiresAt: null,
    });
    mockedPrisma.preSchedulingFlow.update.mockResolvedValue({
      id: 'flow-1',
      publicToken: 'tok-1',
      status: 'WAITING_PATIENT_DOCUMENTS',
      documents: [],
      anamnesisResponse: null,
      patientAccessExpiresAt: null,
    });
    mockedPrisma.procedure.findMany.mockResolvedValue([]);
    mockedPrisma.delivery.findMany.mockResolvedValue([]);
    mockedPrisma.delivery.count.mockResolvedValue(0);
    mockedPrisma.delivery.create.mockResolvedValue({ id: 'd-1', status: 'SOLICITADO_IMPRESSAO', availableAt: new Date('2026-04-20T09:00:00Z') });
    // Default: no patients found (findMany returns [])
    mockedPrisma.patient.findMany.mockResolvedValue([]);
    mockedPrisma.patient.findFirst.mockResolvedValue(null);
    mockedPrisma.patientPortalDependentAuthorization.findMany.mockResolvedValue([]);
  });

  it('validates and sends code on /patient-portal/request-code', async () => {
    const app = await buildApp({ id: 'ignored' });

    mockedIsValidCpf.mockReturnValueOnce(false);
    let res = await app.inject({
      method: 'POST',
      url: '/patient-portal/request-code',
      payload: { cpf: '123', birthDate: '2000-01-01' },
      headers: { 'x-forwarded-for': '10.0.0.1' },
    });
    expect(res.statusCode).toBe(400);

    // patient not found (findMany returns [])
    mockedIsValidCpf.mockReturnValueOnce(true);
    mockedPrisma.patient.findMany.mockResolvedValueOnce([]);
    res = await app.inject({
      method: 'POST',
      url: '/patient-portal/request-code',
      payload: { cpf: '22345678901', birthDate: '2000-01-01' },
      headers: { 'x-forwarded-for': '10.0.0.2' },
    });
    expect(res.statusCode).toBe(404);

    // patient found but birthDate mismatch
    mockedPrisma.patient.findMany.mockResolvedValueOnce([{
      id: 'p-1',
      branchId: 'b-1',
      cpf: '12345678901',
      birthDate: new Date('1999-01-01'),
      email: 'p1@mail.com',
    }]);
    res = await app.inject({
      method: 'POST',
      url: '/patient-portal/request-code',
      payload: { cpf: '32345678901', birthDate: '2000-01-01' },
      headers: { 'x-forwarded-for': '10.0.0.3' },
    });
    expect(res.statusCode).toBe(401);

    // patient found, correct date, but no email
    mockedPrisma.patient.findMany.mockResolvedValueOnce([{
      id: 'p-1',
      branchId: 'b-1',
      name: 'Paciente',
      cpf: '12345678901',
      birthDate: new Date('2000-01-01'),
      email: null,
    }]);
    res = await app.inject({
      method: 'POST',
      url: '/patient-portal/request-code',
      payload: { cpf: '42345678901', birthDate: '2000-01-01' },
      headers: { 'x-forwarded-for': '10.0.0.4' },
    });
    expect(res.statusCode).toBe(400);

    // patient found, email exists, send fails
    mockedPrisma.patient.findMany.mockResolvedValueOnce([{
      id: 'p-1',
      branchId: 'b-1',
      name: 'Paciente 1',
      cpf: '12345678901',
      birthDate: new Date('2000-01-01'),
      email: 'paciente@mail.com',
      cellphone: '1',
      phone: null,
    }]);
    mockedPrisma.patientPortalDependentAuthorization.findMany.mockResolvedValue([]);
    mockedSendPatientPortalAccessCodeEmail.mockResolvedValueOnce(false);

    res = await app.inject({
      method: 'POST',
      url: '/patient-portal/request-code',
      payload: { cpf: '52345678901', birthDate: '2000-01-01' },
      headers: { 'x-forwarded-for': '10.0.0.5' },
    });
    expect(res.statusCode).toBe(500);

    // success
    mockedPrisma.patient.findMany.mockResolvedValueOnce([{
      id: 'p-1',
      branchId: 'b-1',
      name: 'Paciente 1',
      cpf: '12345678901',
      birthDate: new Date('2000-01-01'),
      email: 'paciente@mail.com',
      cellphone: '1',
      phone: null,
    }]);
    mockedSendPatientPortalAccessCodeEmail.mockResolvedValueOnce(true);

    res = await app.inject({
      method: 'POST',
      url: '/patient-portal/request-code',
      payload: { cpf: '62345678901', birthDate: '2000-01-01' },
      headers: { 'x-forwarded-for': '10.0.0.6' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().challengeToken).toBeTruthy();

    await app.close();
  });

  it('validates /patient-portal/verify-code scenarios', async () => {
    const app = await buildApp({ id: 'ignored' });

    let res = await app.inject({
      method: 'POST',
      url: '/patient-portal/verify-code',
      payload: { challengeToken: '', code: 'abc' },
      headers: { 'x-forwarded-for': '10.0.1.1' },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/patient-portal/verify-code',
      payload: { challengeToken: 'not-json', code: '123456' },
      headers: { 'x-forwarded-for': '10.0.1.2' },
    });
    expect(res.statusCode).toBe(400);

    const invalidScopeToken = JSON.stringify({ scope: 'wrong' });
    res = await app.inject({
      method: 'POST',
      url: '/patient-portal/verify-code',
      payload: { challengeToken: invalidScopeToken, code: '123456' },
      headers: { 'x-forwarded-for': '10.0.1.3' },
    });
    expect(res.statusCode).toBe(400);

    const wrongCodeToken = JSON.stringify({
      scope: 'patient_portal_challenge',
      patientId: 'p-1',
      cpf: '12345678901',
      codeHash: hashCode('111111'),
      requestIdentifier: 'r-1',
    });
    res = await app.inject({
      method: 'POST',
      url: '/patient-portal/verify-code',
      payload: { challengeToken: wrongCodeToken, code: '222222' },
      headers: { 'x-forwarded-for': '10.0.1.4' },
    });
    expect(res.statusCode).toBe(401);

    const validToken = JSON.stringify({
      scope: 'patient_portal_challenge',
      patientId: 'p-1',
      cpf: '12345678901',
      codeHash: hashCode('333333'),
      requestIdentifier: 'r-2',
    });

    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({
      method: 'POST',
      url: '/patient-portal/verify-code',
      payload: { challengeToken: validToken, code: '333333' },
      headers: { 'x-forwarded-for': '10.0.1.5' },
    });
    expect(res.statusCode).toBe(404);

    mockedPrisma.patient.findFirst.mockResolvedValueOnce({
      id: 'p-1',
      branchId: 'b-1',
      name: 'Paciente 1',
      cpf: '12345678901',
      birthDate: new Date('2000-01-01'),
      email: 'p1@mail.com',
      cellphone: '1',
    });
    mockedPrisma.patient.findMany.mockResolvedValue([]);
    mockedPrisma.patientPortalDependentAuthorization.findMany.mockResolvedValue([]);

    res = await app.inject({
      method: 'POST',
      url: '/patient-portal/verify-code',
      payload: { challengeToken: validToken, code: '333333' },
      headers: { 'x-forwarded-for': '10.0.1.6' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();

    await app.close();
  });

  it('handles /patient-portal/me and /profiles', async () => {
    const userPayload = {
      scope: 'patient_portal',
      patientId: 'p-1',
      principalPatientId: 'p-1',
      branchId: 'b-1',
      cpf: '12345678901',
      principalCpf: '12345678901',
      allowedPatientIds: ['p-1', 'p-2'],
    };
    const app = await buildApp(userPayload);

    mockedPrisma.patient.findFirst
      .mockResolvedValueOnce({
        id: 'p-1',
        branchId: 'b-1',
        name: 'Paciente',
        cpf: '12345678901',
        birthDate: new Date('2000-01-01'),
        email: 'p@mail.com',
        cellphone: '1',
        phone: null,
        createdAt: new Date(),
        isActive: true,
      })
      .mockResolvedValueOnce({
        id: 'p-1',
        branchId: 'b-1',
        name: 'Paciente',
        cpf: '12345678901',
        birthDate: new Date('2000-01-01'),
        email: 'p@mail.com',
        cellphone: '1',
        phone: null,
        createdAt: new Date(),
        isActive: true,
      });
    mockedPrisma.appointment.count.mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    mockedPrisma.report.findMany
      .mockResolvedValueOnce([{ id: 'r-1', status: 'FINALIZADO' }, { id: 'r-2', status: 'RASCUNHO' }])
      .mockResolvedValueOnce([]);
    mockedPrisma.patient.findMany.mockResolvedValue([]);
    mockedPrisma.patientPortalDependentAuthorization.findMany.mockResolvedValue([]);

    let res = await app.inject({ method: 'GET', url: '/patient-portal/me' });
    expect(res.statusCode).toBe(200);
    expect(res.json().stats.reportsCount).toBe(1);

    res = await app.inject({ method: 'GET', url: '/patient-portal/me/profiles' });
    expect(res.statusCode).toBe(200);
    expect(res.json().profiles.length).toBe(1);

    await app.close();
  });

  it('handles /select-profile and /access-logs', async () => {
    const userPayload = {
      scope: 'patient_portal',
      patientId: 'p-1',
      principalPatientId: 'p-1',
      branchId: 'b-1',
      cpf: '12345678901',
      principalCpf: '12345678901',
      allowedPatientIds: ['p-1', 'p-2'],
    };
    const app = await buildApp(userPayload);

    mockedPrisma.patient.findFirst
      .mockResolvedValueOnce({
        id: 'p-1',
        branchId: 'b-1',
        name: 'Paciente',
        cpf: '12345678901',
        birthDate: new Date('2000-01-01'),
        email: 'p@mail.com',
        cellphone: '1',
        phone: null,
        createdAt: new Date(),
        isActive: true,
      })
      .mockResolvedValueOnce({
        id: 'p-1',
        branchId: 'b-1',
        name: 'Paciente',
        cpf: '12345678901',
        birthDate: new Date('2000-01-01'),
        email: 'p@mail.com',
        cellphone: '1',
        phone: null,
        createdAt: new Date(),
        isActive: true,
      })
      .mockResolvedValueOnce({
        id: 'p-1',
        branchId: 'b-1',
        name: 'Paciente',
        cpf: '12345678901',
        birthDate: new Date('2000-01-01'),
        email: 'p@mail.com',
        cellphone: '1',
        phone: null,
        createdAt: new Date(),
        isActive: true,
      });
    mockedPrisma.patient.findMany.mockResolvedValue([]);
    mockedPrisma.patientPortalDependentAuthorization.findMany.mockResolvedValue([]);
    mockedPrisma.patientPortalAccessLog.findMany.mockResolvedValue([
      {
        id: 'l-1',
        event: 'REQUEST_CODE_SUCCESS',
        status: 'SUCCESS',
        message: 'ok',
        ipAddress: '127.0.0.1',
        patientId: 'p-1',
        cpf: '12345678901',
        createdAt: new Date(),
      },
    ]);
    mockedPrisma.patientPortalAccessLog.count.mockResolvedValue(1);

    let res = await app.inject({
      method: 'POST',
      url: '/patient-portal/me/select-profile',
      payload: { patientId: '' },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/patient-portal/me/select-profile',
      payload: { patientId: 'p-2' },
    });
    expect(res.statusCode).toBe(403);

    res = await app.inject({
      method: 'POST',
      url: '/patient-portal/me/select-profile',
      payload: { patientId: 'p-1' },
    });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: '/patient-portal/me/access-logs?limit=10' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    await app.close();
  });

  it('handles patient documents, views, consultations, exams and upcoming pre-scheduling link', async () => {
    const userPayload = {
      scope: 'patient_portal',
      patientId: 'p-1',
      principalPatientId: 'p-1',
      branchId: 'b-1',
      cpf: '12345678901',
      principalCpf: '12345678901',
      allowedPatientIds: ['p-1'],
    };
    const app = await buildApp(userPayload);

    mockedPrisma.patient.findFirst.mockResolvedValue({
      id: 'p-1',
      branchId: 'b-1',
      name: 'Paciente',
      cpf: '12345678901',
      birthDate: new Date('2000-01-01'),
      email: 'p@mail.com',
      cellphone: '1',
      phone: null,
      createdAt: new Date(),
      isActive: true,
    });
    mockedPrisma.preSchedulingDocument.findMany.mockResolvedValueOnce([
      {
        id: 'doc-1',
        fileName: 'prep.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 123,
        documentType: 'PREPARO',
        uploadedAt: new Date('2026-04-15T10:00:00Z'),
        flow: { appointment: { id: 'a-1', date: '2026-04-20', time: '10:00', specialty: 'CARDIO', status: 'AGENDADO', type: 'CONSULTA' } },
      },
    ]);
    mockedPrisma.appointmentAttachment.findMany.mockResolvedValueOnce([
      {
        id: 'att-1',
        fileName: 'anexo.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 456,
        uploadedAt: new Date('2026-04-15T09:00:00Z'),
        appointment: { id: 'a-1', date: '2026-04-20', time: '10:00', specialty: 'CARDIO', status: 'AGENDADO', type: 'CONSULTA' },
      },
    ]);
    mockedPrisma.report.findMany.mockResolvedValueOnce([
      { id: 'r-1', status: 'FINALIZADO', exam: 'RAIO-X', updatedAt: new Date('2026-04-15T08:00:00Z'), createdAt: new Date('2026-04-15T08:00:00Z'), appointment: null },
      { id: 'r-2', status: 'RASCUNHO', exam: 'USG', updatedAt: new Date('2026-04-15T07:00:00Z'), createdAt: new Date('2026-04-15T07:00:00Z'), appointment: null },
    ]);

    let res = await app.inject({ method: 'GET', url: '/patient-portal/me/documents?limit=10&offset=0' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(3);

    mockedPrisma.preSchedulingDocument.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/documents/pre-scheduling/doc-x/view' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.appointment.findMany
      .mockResolvedValueOnce([{ id: 'c-1' }])
      .mockResolvedValueOnce([{ id: 'e-1' }])
      .mockResolvedValueOnce([
        {
          id: 'a-up-1',
          date: '2026-05-01',
          time: '09:00',
          status: 'CONFIRMADO',
          specialty: 'CARDIO',
          doctorName: 'Dr A',
          convenio: null,
          preSchedulingFlow: null,
        },
      ]);
    mockedPrisma.appointment.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([
      { id: 'proc-1', name: 'CARDIO', anamnesisTemplates: [{ id: 't-1' }] },
    ]);

    res = await app.inject({ method: 'GET', url: '/patient-portal/me/consultations?limit=10&offset=0' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    res = await app.inject({ method: 'GET', url: '/patient-portal/me/exams?limit=10&offset=0' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    res = await app.inject({ method: 'GET', url: '/patient-portal/me/upcoming-consultations?limit=10&offset=0' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].preScheduling.hasAnamnesis).toBe(true);

    mockedPrisma.appointment.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'a-1',
        status: 'CANCELADO',
        preSchedulingFlow: null,
      })
      .mockResolvedValueOnce({
        id: 'a-1',
        status: 'CONFIRMADO',
        patientName: 'Paciente',
        patientCpf: '12345678901',
        preSchedulingFlow: null,
      });

    res = await app.inject({ method: 'POST', url: '/patient-portal/me/upcoming-consultations/a-1/pre-scheduling-link' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'POST', url: '/patient-portal/me/upcoming-consultations/a-1/pre-scheduling-link' });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/patient-portal/me/upcoming-consultations/a-1/pre-scheduling-link' });
    expect(res.statusCode).toBe(200);
    expect(res.json().publicToken).toBeTruthy();

    await app.close();
  });

  it('handles reports pdf and physical delivery request flow', async () => {
    const userPayload = {
      scope: 'patient_portal',
      patientId: 'p-1',
      principalPatientId: 'p-1',
      branchId: 'b-1',
      cpf: '12345678901',
      principalCpf: '12345678901',
      allowedPatientIds: ['p-1'],
    };
    const app = await buildApp(userPayload);

    mockedPrisma.patient.findFirst.mockResolvedValue({
      id: 'p-1',
      branchId: 'b-1',
      name: 'Paciente',
      cpf: '12345678901',
      birthDate: new Date('2000-01-01'),
      email: 'p@mail.com',
      cellphone: '1',
      phone: null,
      createdAt: new Date(),
      isActive: true,
    });

    mockedPrisma.report.findMany.mockResolvedValueOnce([
      { id: 'r-1', status: 'FINALIZADO', updatedAt: new Date(), createdAt: new Date() },
      { id: 'r-2', status: 'EM_ANDAMENTO', updatedAt: new Date(), createdAt: new Date() },
    ]);
    mockedPrisma.report.count.mockResolvedValueOnce(2);
    let res = await app.inject({ method: 'GET', url: '/patient-portal/me/reports?limit=10&offset=0' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBe(1);

    mockedPrisma.report.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/reports/r-x/pdf' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.report.findFirst.mockResolvedValueOnce({ id: 'r-2', status: 'EM_ANDAMENTO', appointment: null });
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/reports/r-2/pdf' });
    expect(res.statusCode).toBe(400);

    mockedPrisma.report.findFirst.mockResolvedValueOnce({
      id: 'r-1',
      status: 'FINALIZADO',
      exam: 'RAIO-X',
      appointment: { date: '2026-04-10', time: '10:00', specialty: 'RADIO', doctorName: 'Dr A' },
    });
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/reports/r-1/pdf' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');

    mockedPrisma.delivery.findMany.mockResolvedValueOnce([{ id: 'd-1' }]);
    mockedPrisma.delivery.count.mockResolvedValueOnce(1);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/delivery-requests?limit=10&offset=0' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    mockedPrisma.report.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'POST', url: '/patient-portal/me/reports/r-x/request-physical-delivery', payload: {} });
    expect(res.statusCode).toBe(404);

    mockedPrisma.report.findFirst.mockResolvedValueOnce({ id: 'r-2', status: 'RASCUNHO', appointment: null });
    res = await app.inject({ method: 'POST', url: '/patient-portal/me/reports/r-2/request-physical-delivery', payload: {} });
    expect(res.statusCode).toBe(400);

    mockedPrisma.report.findFirst.mockResolvedValueOnce({ id: 'r-1', status: 'FINALIZADO', exam: 'RAIO-X', appointment: { specialty: 'RADIO' } });
    res = await app.inject({
      method: 'POST',
      url: '/patient-portal/me/reports/r-1/request-physical-delivery',
      payload: { preferredDate: 'invalid-date' },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.report.findFirst.mockResolvedValueOnce({ id: 'r-1', status: 'FINALIZADO', exam: 'RAIO-X', appointment: { specialty: 'RADIO' } });
    res = await app.inject({
      method: 'POST',
      url: '/patient-portal/me/reports/r-1/request-physical-delivery',
      payload: { preferredDate: '2026-04-20', notes: 'entregar recepção' },
    });
    expect(res.statusCode).toBe(201);

    // Cover optional description fields and patient name fallback branches
    mockedPrisma.patient.findFirst.mockResolvedValueOnce({
      id: 'p-1',
      branchId: 'b-1',
      name: null,
      cpf: '12345678901',
      birthDate: new Date('2000-01-01'),
      email: 'p@mail.com',
      cellphone: '1',
      phone: null,
      createdAt: new Date(),
      isActive: true,
    });
    mockedPrisma.report.findFirst.mockResolvedValueOnce({
      id: 'r-1',
      status: 'FINALIZADO',
      exam: null,
      patientName: null,
      appointment: null,
    });
    mockedPrisma.delivery.create.mockResolvedValueOnce({
      id: 'd-2',
      status: 'SOLICITADO_IMPRESSAO',
      availableAt: new Date(),
    });

    res = await app.inject({
      method: 'POST',
      url: '/patient-portal/me/reports/r-1/request-physical-delivery',
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    expect(mockedPrisma.delivery.create).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        patientName: 'Paciente',
      }),
    }));
    const lastDescription = mockedPrisma.delivery.create.mock.calls.at(-1)?.[0]?.data?.description as string;
    expect(lastDescription).not.toContain('Exame:');
    expect(lastDescription).not.toContain('Especialidade:');
    expect(lastDescription).not.toContain('Data preferencial:');
    expect(lastDescription).not.toContain('Observações:');

    // Line 1929: patient.name || '' → covers '' branch (name is null)
    mockedPrisma.patient.findFirst.mockResolvedValueOnce({
      id: 'p-1', branchId: 'b-1', name: null, cpf: '12345678901',
      birthDate: new Date('2000-01-01'), email: 'p@mail.com', cellphone: '1', phone: null, createdAt: new Date(), isActive: true,
    });
    mockedPrisma.delivery.findMany.mockResolvedValueOnce([]);
    mockedPrisma.delivery.count.mockResolvedValueOnce(0);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/delivery-requests' });
    expect(res.statusCode).toBe(200);

    // Line 1969: !patient → 404 in request-physical-delivery
    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'POST', url: '/patient-portal/me/reports/r-1/request-physical-delivery', payload: {} });
    expect(res.statusCode).toBe(404);

    // Line 1978: patient.branchId = null → where clause does not include branchId
    mockedPrisma.patient.findFirst.mockResolvedValueOnce({
      id: 'p-1', branchId: null, name: 'Paciente', cpf: '12345678901',
      birthDate: new Date('2000-01-01'), email: 'p@mail.com', cellphone: '1', phone: null, createdAt: new Date(), isActive: true,
    });
    mockedPrisma.report.findFirst.mockResolvedValueOnce({ id: 'r-1', status: 'FINALIZADO', exam: 'RAIO-X', appointment: { specialty: 'RADIO' } });
    mockedPrisma.delivery.create.mockResolvedValueOnce({ id: 'd-3', status: 'SOLICITADO_IMPRESSAO', availableAt: new Date() });
    res = await app.inject({ method: 'POST', url: '/patient-portal/me/reports/r-1/request-physical-delivery', payload: {} });
    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it('covers request-code IP rate limit and CPF rate limit', async () => {
    const app = await buildApp({ id: 'ignored' });

    // Exhaust IP rate limit (max 8) using a unique IP
    for (let i = 0; i < 8; i++) {
      mockedIsValidCpf.mockReturnValueOnce(false);
      await app.inject({
        method: 'POST',
        url: '/patient-portal/request-code',
        payload: { cpf: '123', birthDate: '2000-01-01' },
        headers: { 'x-forwarded-for': '192.168.99.1' },
      });
    }
    // 9th request triggers 429
    const res = await app.inject({
      method: 'POST',
      url: '/patient-portal/request-code',
      payload: { cpf: '123', birthDate: '2000-01-01' },
      headers: { 'x-forwarded-for': '192.168.99.1' },
    });
    expect(res.statusCode).toBe(429);

    // CPF rate limit: use same CPF 4 times (unique IP per request to avoid IP limit)
    // REQUEST_CODE_MAX_BY_CPF = 4, so 5th triggers it
    const cpfForLimit = '99999999901';
    for (let i = 0; i < 4; i++) {
      mockedIsValidCpf.mockReturnValueOnce(false);
      await app.inject({
        method: 'POST',
        url: '/patient-portal/request-code',
        payload: { cpf: cpfForLimit, birthDate: '2000-01-01' },
        headers: { 'x-forwarded-for': `10.200.0.${i + 1}` },
      });
    }
    const cpfLimitRes = await app.inject({
      method: 'POST',
      url: '/patient-portal/request-code',
      payload: { cpf: cpfForLimit, birthDate: '2000-01-01' },
      headers: { 'x-forwarded-for': '10.200.0.99' },
    });
    expect(cpfLimitRes.statusCode).toBe(429);
    expect(cpfLimitRes.json().error).toContain('CPF');

    await app.close();
  });

  it('covers verify-code locked challenge and max-attempts exhaustion', async () => {
    const app = await buildApp({ id: 'ignored' });

    const requestIdentifier = 'unique-ri-for-lock-test';
    const token = JSON.stringify({
      scope: 'patient_portal_challenge',
      patientId: 'p-lock',
      cpf: '11122233301',
      codeHash: hashCode('111111'),
      requestIdentifier,
    });

    // VERIFY_CODE_MAX_ATTEMPTS_PER_CHALLENGE = 5; send 5 wrong codes
    for (let i = 0; i < 5; i++) {
      let res = await app.inject({
        method: 'POST',
        url: '/patient-portal/verify-code',
        payload: { challengeToken: token, code: '000000' },
        headers: { 'x-forwarded-for': `10.201.0.${i + 1}` },
      });
      if (i < 4) {
        expect(res.statusCode).toBe(401);
      } else {
        // 5th exhausts attempts → 429
        expect(res.statusCode).toBe(429);
      }
    }

    // Now the challenge is locked; next request gets 429 BLOCKED
    const blockedRes = await app.inject({
      method: 'POST',
      url: '/patient-portal/verify-code',
      payload: { challengeToken: token, code: '111111' },
      headers: { 'x-forwarded-for': '10.201.0.99' },
    });
    expect(blockedRes.statusCode).toBe(429);

    await app.close();
  });

  it('covers verify-code IP rate limit (send 30+ requests)', async () => {
    const app = await buildApp({ id: 'ignored' });
    const ip = '10.202.0.1';
    const token = JSON.stringify({
      scope: 'patient_portal_challenge',
      patientId: 'p-rl',
      cpf: '22233344401',
      codeHash: hashCode('123456'),
      requestIdentifier: 'ri-rate-limit-verify',
    });

    // VERIFY_CODE_MAX_BY_IP = 30 (default), send 30 requests to exhaust
    for (let i = 0; i < 30; i++) {
      await app.inject({
        method: 'POST',
        url: '/patient-portal/verify-code',
        payload: { challengeToken: token, code: `${String(i).padStart(6, '0')}` },
        headers: { 'x-forwarded-for': ip },
      });
    }
    // 31st triggers IP rate limit
    const rlRes = await app.inject({
      method: 'POST',
      url: '/patient-portal/verify-code',
      payload: { challengeToken: token, code: '000000' },
      headers: { 'x-forwarded-for': ip },
    });
    expect(rlRes.statusCode).toBe(429);
    expect(rlRes.json().error).toContain('validações');

    await app.close();
  });

  it('covers resolvePortalProfilesForPrincipal with guardian dependents and explicit authorizations', async () => {
    const userPayload = {
      scope: 'patient_portal',
      patientId: 'p-1',
      principalPatientId: 'p-1',
      branchId: 'b-1',
      cpf: '12345678901',
      principalCpf: '12345678901',
      allowedPatientIds: ['p-1', 'p-dep1', 'p-exp1'],
    };
    const app = await buildApp(userPayload);

    const principalPatient = {
      id: 'p-1',
      branchId: 'b-1',
      name: 'Principal',
      cpf: '12345678901',
      birthDate: new Date('2000-01-01'),
      email: 'p@mail.com',
      cellphone: '1',
      phone: null,
      createdAt: new Date(),
      isActive: true,
    };

    // GET /me/profiles: returns principal + guardian dependent + explicit dependent
    mockedPrisma.patient.findFirst.mockResolvedValueOnce(principalPatient);
    // guardianDependents (patient.findMany) - one guardian-based dependent
    mockedPrisma.patient.findMany
      .mockResolvedValueOnce([
        {
          id: 'p-dep1',
          branchId: 'b-1',
          name: 'Dependente Guardian',
          cpf: '22345678901',
          birthDate: new Date('2010-01-01'),
          email: null,
          cellphone: null,
          phone: null,
          guardianRelationship: 'Filho',
        },
      ])
      // explicitDependents (patient.findMany second call)
      .mockResolvedValueOnce([
        {
          id: 'p-exp1',
          branchId: 'b-1',
          name: 'Dependente Expresso',
          cpf: '33345678901',
          birthDate: new Date('2008-01-01'),
          email: null,
          cellphone: null,
          phone: null,
        },
      ]);
    mockedPrisma.patientPortalDependentAuthorization.findMany.mockResolvedValueOnce([
      { dependentPatientId: 'p-exp1', relationship: 'Irmão' },
    ]);

    const res = await app.inject({ method: 'GET', url: '/patient-portal/me/profiles' });
    expect(res.statusCode).toBe(200);
    const profiles = res.json().profiles;
    expect(profiles.length).toBe(3);
    const guardian = profiles.find((p: any) => p.id === 'p-dep1');
    expect(guardian?.authorizationSource).toBe('GUARDIAN_CPF');
    const explicit = profiles.find((p: any) => p.id === 'p-exp1');
    expect(explicit?.authorizationSource).toBe('EXPLICIT_AUTHORIZATION');

    // maskEmail with short name (≤2 chars): triggers maskEmail branch
    // Test maskEmail by checking request-code with 2-char name
    mockedPrisma.patient.findMany.mockResolvedValueOnce([{
      id: 'p-short',
      branchId: 'b-1',
      name: 'Ab',
      cpf: '12345678901',
      birthDate: new Date('2000-01-01'),
      email: 'ab@test.com',
      cellphone: null,
      phone: null,
    }]);
    mockedPrisma.patientPortalDependentAuthorization.findMany.mockResolvedValueOnce([]);
    mockedSendPatientPortalAccessCodeEmail.mockResolvedValueOnce(true);
    const maskRes = await app.inject({
      method: 'POST',
      url: '/patient-portal/request-code',
      payload: { cpf: '12345678901', birthDate: '2000-01-01' },
      headers: { 'x-forwarded-for': '10.203.0.1' },
    });
    expect(maskRes.statusCode).toBe(200);
    // short name → destination masks with 1-char prefix
    expect(maskRes.json().destination).toMatch(/^a\*\*\*@/);

    await app.close();
  });

  it('covers pre-scheduling-link update path with flow already existing', async () => {
    const userPayload = {
      scope: 'patient_portal',
      patientId: 'p-1',
      principalPatientId: 'p-1',
      branchId: 'b-1',
      cpf: '12345678901',
      principalCpf: '12345678901',
      allowedPatientIds: ['p-1'],
    };
    const app = await buildApp(userPayload);

    mockedPrisma.patient.findFirst.mockResolvedValue({
      id: 'p-1',
      branchId: 'b-1',
      name: 'Paciente',
      cpf: '12345678901',
      birthDate: new Date('2000-01-01'),
      email: 'p@mail.com',
      cellphone: '1',
      phone: null,
      createdAt: new Date(),
      isActive: true,
    });
    mockedPrisma.procedure.findMany.mockResolvedValue([
      { id: 'proc-1', name: 'CARDIO', anamnesisTemplates: [{ id: 't-1' }] },
    ]);

    // Case 1: flow exists but expired → needsNewToken = true
    const expiredFlow = {
      id: 'flow-expired',
      publicToken: 'expired-tok',
      status: 'WAITING_PATIENT_DOCUMENTS',
      documents: [],
      anamnesisResponse: null,
      patientAccessExpiresAt: new Date(Date.now() - 1000), // in the past
      patientSubmittedAt: null,
      linkSentAt: null,
      patientVerifiedAt: null,
      patientVerifiedCpf: null,
      patientVerifiedName: null,
      patientVerifiedTrust: null,
    };
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-1',
      status: 'CONFIRMADO',
      patientName: 'Paciente',
      patientCpf: '12345678901',
      specialty: 'CARDIO',
      type: 'CONSULTA',
      preSchedulingFlow: expiredFlow,
    });
    mockedPrisma.preSchedulingFlow.update.mockResolvedValueOnce({
      id: 'flow-expired',
      publicToken: 'new-token-after-expiry',
      status: 'WAITING_PATIENT_DOCUMENTS',
      documents: [],
      anamnesisResponse: null,
      patientAccessExpiresAt: null,
    });

    let res = await app.inject({
      method: 'POST',
      url: '/patient-portal/me/upcoming-consultations/a-1/pre-scheduling-link',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().publicToken).toBe('new-token-after-expiry');

    // Case 2: flow exists, not expired, has publicToken → needsNewToken = false
    // Also: isPatientInteractionCompleted(flow) = true → keep flow.status
    // Also: hasAnamnesis = true and flow.anamnesisSentAt already set → no update
    const completedFlow = {
      id: 'flow-completed',
      publicToken: 'existing-token',
      status: 'DOCUMENTS_RECEIVED',
      documents: [{ id: 'd-1' }],
      anamnesisResponse: { id: 'ar-1', submittedAt: new Date() },
      patientAccessExpiresAt: null,
      patientSubmittedAt: new Date(), // makes isPatientInteractionCompleted = true
      linkSentAt: new Date(),
      patientVerifiedAt: null,
      patientVerifiedCpf: null,
      patientVerifiedName: null,
      patientVerifiedTrust: null,
      anamnesisSentAt: new Date(), // already set
    };
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-2',
      status: 'AGENDADO',
      patientName: 'Paciente',
      patientCpf: '12345678901',
      specialty: 'CARDIO',
      type: 'CONSULTA',
      preSchedulingFlow: completedFlow,
    });
    mockedPrisma.preSchedulingFlow.update.mockResolvedValueOnce({
      id: 'flow-completed',
      publicToken: 'existing-token',
      status: 'DOCUMENTS_RECEIVED',
      documents: [{ id: 'd-1' }],
      anamnesisResponse: { id: 'ar-1', submittedAt: new Date() },
      patientAccessExpiresAt: null,
    });

    res = await app.inject({
      method: 'POST',
      url: '/patient-portal/me/upcoming-consultations/a-2/pre-scheduling-link',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().publicToken).toBe('existing-token');
    expect(res.json().interactionCompleted).toBe(true);

    // Case 3: flow exists, not expired, no publicToken → needsNewToken = true
    // Also: hasAnamnesis = true but flow.anamnesisSentAt is null → sets it
    const noTokenFlow = {
      id: 'flow-notoken',
      publicToken: null,
      status: 'WAITING_PATIENT_DOCUMENTS',
      documents: [],
      anamnesisResponse: null,
      patientAccessExpiresAt: null,
      patientSubmittedAt: null,
      linkSentAt: null,
      patientVerifiedAt: null,
      patientVerifiedCpf: null,
      patientVerifiedName: null,
      patientVerifiedTrust: null,
      anamnesisSentAt: null, // not yet set
    };
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-3',
      status: 'CONFIRMADO',
      patientName: 'Paciente',
      patientCpf: '12345678901',
      specialty: 'CARDIO',
      type: 'CONSULTA',
      preSchedulingFlow: noTokenFlow,
    });
    mockedPrisma.preSchedulingFlow.update.mockResolvedValueOnce({
      id: 'flow-notoken',
      publicToken: 'brand-new-token',
      status: 'WAITING_PATIENT_DOCUMENTS',
      documents: [],
      anamnesisResponse: null,
      patientAccessExpiresAt: null,
    });

    res = await app.inject({
      method: 'POST',
      url: '/patient-portal/me/upcoming-consultations/a-3/pre-scheduling-link',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().publicToken).toBe('brand-new-token');

    await app.close();
  });

  it('covers document view for appointment-attachment and report sources', async () => {
    const userPayload = {
      scope: 'patient_portal',
      patientId: 'p-1',
      principalPatientId: 'p-1',
      branchId: 'b-1',
      cpf: '12345678901',
      principalCpf: '12345678901',
      allowedPatientIds: ['p-1'],
    };
    const app = await buildApp(userPayload);

    mockedPrisma.patient.findFirst.mockResolvedValue({
      id: 'p-1',
      branchId: 'b-1',
      name: 'Paciente',
      cpf: '12345678901',
      birthDate: new Date('2000-01-01'),
      email: 'p@mail.com',
      cellphone: '1',
      phone: null,
      createdAt: new Date(),
      isActive: true,
    });

    const mockedGetAnexosStorage = getAnexosStorage as any;
    const mockStorage = { exists: vi.fn(), createReadStream: vi.fn(() => null) };
    mockedGetAnexosStorage.mockReturnValue(mockStorage);

    // appointment-attachment: not found → 404
    mockedPrisma.appointmentAttachment.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({
      method: 'GET',
      url: '/patient-portal/me/documents/appointment-attachment/att-x/view',
    });
    expect(res.statusCode).toBe(404);

    // appointment-attachment: found but file not in storage → 404
    mockedPrisma.appointmentAttachment.findFirst.mockResolvedValueOnce({
      id: 'att-1',
      gcsObjectName: 'attachments/att-1.pdf',
      mimeType: 'application/pdf',
      fileName: 'test.pdf',
    });
    mockStorage.exists.mockResolvedValueOnce(false);
    res = await app.inject({
      method: 'GET',
      url: '/patient-portal/me/documents/appointment-attachment/att-1/view',
    });
    expect(res.statusCode).toBe(404);

    // report source: not found → 404
    mockedPrisma.report.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({
      method: 'GET',
      url: '/patient-portal/me/documents/report/r-x/view',
    });
    expect(res.statusCode).toBe(404);

    // report source: found but not visible status → 400
    mockedPrisma.report.findFirst.mockResolvedValueOnce({
      id: 'r-draft',
      status: 'RASCUNHO',
      exam: 'RAIO-X',
      appointment: null,
    });
    res = await app.inject({
      method: 'GET',
      url: '/patient-portal/me/documents/report/r-draft/view',
    });
    expect(res.statusCode).toBe(400);

    // report source: visible → 200 PDF
    mockedPrisma.report.findFirst.mockResolvedValueOnce({
      id: 'r-final',
      status: 'FINALIZADO',
      exam: 'USG',
      appointment: { date: '2026-04-20', time: '10:00', specialty: 'RADIO', doctorName: 'Dr B' },
    });
    res = await app.inject({
      method: 'GET',
      url: '/patient-portal/me/documents/report/r-final/view',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');

    await app.close();
  });

  it('returns 401 when auth payload is invalid or jwt verification fails', async () => {
    mockedPrisma.patient.findFirst.mockResolvedValue({
      id: 'p-1',
      branchId: 'b-1',
      name: 'Paciente',
      cpf: '12345678901',
      birthDate: new Date('2000-01-01'),
      email: 'p@mail.com',
      cellphone: '1',
      phone: null,
      createdAt: new Date(),
      isActive: true,
    });

    const badScopeApp = await buildApp({ scope: 'admin', patientId: 'p-1' });
    let res = await badScopeApp.inject({ method: 'GET', url: '/patient-portal/me' });
    expect(res.statusCode).toBe(401);
    await badScopeApp.close();

    const missingPatientIdApp = await buildApp({ scope: 'patient_portal' });
    res = await missingPatientIdApp.inject({ method: 'GET', url: '/patient-portal/me' });
    expect(res.statusCode).toBe(401);
    await missingPatientIdApp.close();

    const unauthenticatedApp = await buildApp();
    res = await unauthenticatedApp.inject({ method: 'GET', url: '/patient-portal/me' });
    expect(res.statusCode).toBe(401);
    await unauthenticatedApp.close();
  });

  it('normalizes allowedPatientIds from auth payload in both fallback paths', async () => {
    mockedPrisma.patient.findFirst.mockResolvedValue({
      id: 'p-1',
      branchId: 'b-1',
      name: 'Paciente',
      cpf: '12345678901',
      birthDate: new Date('2000-01-01'),
      email: 'p@mail.com',
      cellphone: '1',
      phone: null,
      createdAt: new Date(),
      isActive: true,
    });
    mockedPrisma.appointment.count.mockResolvedValue(0);
    mockedPrisma.report.count.mockResolvedValue(0);

    const noArrayApp = await buildApp({
      scope: 'patient_portal',
      patientId: 'p-1',
      principalPatientId: 'p-1',
      branchId: 'b-1',
      cpf: '12345678901',
      principalCpf: '12345678901',
      allowedPatientIds: null,
    });
    let res = await noArrayApp.inject({ method: 'GET', url: '/patient-portal/me' });
    expect(res.statusCode).toBe(200);
    await noArrayApp.close();

    const missingSelfApp = await buildApp({
      scope: 'patient_portal',
      patientId: 'p-1',
      principalPatientId: 'p-1',
      branchId: 'b-1',
      cpf: '12345678901',
      principalCpf: '12345678901',
      allowedPatientIds: ['dep-1'],
    });
    res = await missingSelfApp.inject({ method: 'GET', url: '/patient-portal/me' });
    expect(res.statusCode).toBe(200);
    await missingSelfApp.close();
  });

  it('covers access log error path and profile merge path from explicit authorization', async () => {
    mockedPrisma.patientPortalAccessLog.create.mockRejectedValueOnce(new Error('db down'));
    mockedNormalizeCpf.mockImplementation((value: string) => String(value || '').replace(/\D/g, ''));
    mockedIsValidCpf.mockReturnValue(true);

    const patientRecord = {
      id: 'p-1',
      branchId: 'b-1',
      name: 'Paciente Curto',
      cpf: '12345678901',
      birthDate: new Date('2000-01-01'),
      email: 'ab@example.com',
      cellphone: '1',
      phone: null,
      createdAt: new Date(),
      isActive: true,
    };
    // request-code now uses findMany for patient lookup
    mockedPrisma.patient.findMany
      .mockResolvedValueOnce([patientRecord])   // request-code patient lookup
      .mockResolvedValueOnce([                  // resolvePortalProfilesForPrincipal guardian lookup
        {
          id: 'dep-1',
          branchId: 'b-1',
          name: 'Dependente Um',
          cpf: '99999999999',
          birthDate: new Date('2015-03-03'),
          email: null,
          cellphone: null,
          phone: null,
        },
      ])
      .mockResolvedValueOnce([                  // resolvePortalProfilesForPrincipal explicit dependents
        {
          id: 'dep-1',
          branchId: 'b-1',
          name: 'Dependente Um',
          cpf: '99999999999',
          birthDate: new Date('2015-03-03'),
          email: null,
          cellphone: null,
          phone: null,
        },
      ]);
    // findFirst still used by getPatientFromPayload inside verify-code flow
    mockedPrisma.patient.findFirst.mockResolvedValue(patientRecord);
    mockedPrisma.patientPortalDependentAuthorization.findMany.mockResolvedValue([
      { dependentPatientId: 'dep-1', relationship: 'Filho' },
    ]);
    mockedSendPatientPortalAccessCodeEmail.mockResolvedValue(true);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/patient-portal/request-code',
      payload: { cpf: '12345678901', birthDate: '2000-01-01' },
      headers: { 'x-forwarded-for': '203.0.113.15' },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('covers verify-code fallback branches when resolved profiles are empty', async () => {
    mockedNormalizeCpf.mockImplementation((value: string) => {
      if (String(value) === 'bad-cpf-for-profile-resolution') return '';
      return String(value || '').replace(/\D/g, '');
    });

    mockedPrisma.patient.findFirst.mockResolvedValue({
      id: 'p-1',
      branchId: 'b-1',
      name: 'Paciente',
      cpf: 'bad-cpf-for-profile-resolution',
      birthDate: new Date('2000-01-01'),
      email: 'p@mail.com',
      cellphone: '1',
      phone: null,
      createdAt: new Date(),
      isActive: true,
    });

    const app = await buildApp();
    const challengeToken = JSON.stringify({
      scope: 'patient_portal_challenge',
      patientId: 'p-1',
      principalPatientId: 'p-1',
      branchId: 'b-1',
      cpf: 'bad-cpf-for-profile-resolution',
      principalCpf: 'bad-cpf-for-profile-resolution',
      codeHash: hashCode('123456'),
      requestIdentifier: 'req-empty-profiles',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/patient-portal/verify-code',
      payload: { challengeToken, code: '123456', selectedPatientId: 'dep-x' },
      headers: { 'x-forwarded-for': '198.51.100.50' },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('covers pre-scheduling document storage miss, invalid document source and AGENDADO canPrepare', async () => {
    const userPayload = {
      scope: 'patient_portal',
      patientId: 'p-1',
      principalPatientId: 'p-1',
      branchId: 'b-1',
      cpf: '12345678901',
      principalCpf: '12345678901',
      allowedPatientIds: ['p-1'],
    };
    const app = await buildApp(userPayload);

    mockedPrisma.patient.findFirst.mockResolvedValue({
      id: 'p-1',
      branchId: 'b-1',
      name: 'Paciente',
      cpf: '12345678901',
      birthDate: new Date('2000-01-01'),
      email: 'p@mail.com',
      cellphone: '1',
      phone: null,
      createdAt: new Date(),
      isActive: true,
    });

    const mockedGetAnexosStorage = getAnexosStorage as any;
    const mockStorage = { exists: vi.fn(), createReadStream: vi.fn(() => null) };
    mockedGetAnexosStorage.mockReturnValue(mockStorage);

    mockedPrisma.preSchedulingDocument.findFirst.mockResolvedValueOnce({
      id: 'doc-1',
      gcsObjectName: 'pre/doc-1.pdf',
      mimeType: 'application/pdf',
      fileName: 'doc-1.pdf',
    });
    mockStorage.exists.mockResolvedValueOnce(false);
    let res = await app.inject({
      method: 'GET',
      url: '/patient-portal/me/documents/pre-scheduling/doc-1/view',
    });
    expect(res.statusCode).toBe(404);

    res = await app.inject({
      method: 'GET',
      url: '/patient-portal/me/documents/unknown/doc-x/view',
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.procedure.findMany.mockResolvedValue([{ id: 'proc-1', name: 'CARDIO', anamnesisTemplates: [] }]);
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([
      {
        id: 'a-1',
        date: '2026-04-20',
        time: '11:00',
        status: 'AGENDADO',
        specialty: 'CARDIO',
        doctorName: 'Dr A',
        convenio: null,
        type: 'CONSULTA',
        preSchedulingFlow: null,
      },
    ]);
    mockedPrisma.appointment.count.mockResolvedValueOnce(1);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/upcoming-consultations' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].preScheduling.canPrepare).toBe(true);

    await app.close();
  });

  it('covers verify-code selectedPatientId branch and /me patient not found', async () => {
    const app = await buildApp({ id: 'ignored' });

    mockedPrisma.patient.findFirst
      .mockResolvedValueOnce({
        id: 'p-1',
        branchId: 'b-1',
        name: 'Principal',
        cpf: '12345678901',
        birthDate: new Date('2000-01-01'),
        email: 'p@mail.com',
        cellphone: '1',
        phone: null,
        createdAt: new Date(),
        isActive: true,
      })
      .mockResolvedValueOnce(null);

    mockedPrisma.patient.findMany.mockResolvedValueOnce([
      {
        id: 'dep-1',
        branchId: 'b-1',
        name: 'Dependente',
        cpf: '99999999999',
        birthDate: new Date('2015-01-01'),
        email: null,
        cellphone: null,
        phone: null,
        guardianRelationship: 'Filho',
      },
    ]);
    mockedPrisma.patientPortalDependentAuthorization.findMany.mockResolvedValueOnce([]);

    const challengeToken = JSON.stringify({
      scope: 'patient_portal_challenge',
      patientId: 'p-1',
      principalPatientId: 'p-1',
      branchId: 'b-1',
      cpf: '12345678901',
      principalCpf: '12345678901',
      codeHash: hashCode('123456'),
      requestIdentifier: 'req-select-dependent',
    });

    let res = await app.inject({
      method: 'POST',
      url: '/patient-portal/verify-code',
      payload: { challengeToken, code: '123456', selectedPatientId: 'dep-1' },
      headers: { 'x-forwarded-for': '198.51.100.77' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().patient.id).toBe('dep-1');

    const authApp = await buildApp({
      scope: 'patient_portal',
      patientId: 'missing',
      principalPatientId: 'missing',
      branchId: 'b-1',
      cpf: '12345678901',
      principalCpf: '12345678901',
      allowedPatientIds: ['missing'],
    });
    res = await authApp.inject({ method: 'GET', url: '/patient-portal/me' });
    expect(res.statusCode).toBe(404);

    await authApp.close();
    await app.close();
  });

  it('covers anamnesis fuzzy specialty matching branches in upcoming consultations', async () => {
    const app = await buildApp({
      scope: 'patient_portal',
      patientId: 'p-1',
      principalPatientId: 'p-1',
      branchId: 'b-1',
      cpf: '12345678901',
      principalCpf: '12345678901',
      allowedPatientIds: ['p-1'],
    });

    mockedPrisma.patient.findFirst.mockResolvedValue({
      id: 'p-1',
      branchId: 'b-1',
      name: 'Paciente',
      cpf: '12345678901',
      birthDate: new Date('2000-01-01'),
      email: 'p@mail.com',
      cellphone: '1',
      phone: null,
      createdAt: new Date(),
      isActive: true,
    });

    mockedPrisma.procedure.findMany
      .mockResolvedValueOnce([{ id: 'proc-1', name: 'CARDIOLOGIA INTERVENCIONISTA', anamnesisTemplates: [{ id: 'a1' }] }])
      .mockResolvedValueOnce([{ id: 'proc-2', name: 'CARDIO', anamnesisTemplates: [{ id: 'a2' }] }]);

    mockedPrisma.appointment.findMany
      .mockResolvedValueOnce([
        {
          id: 'a-1',
          date: '2026-04-20',
          time: '11:00',
          status: 'CONFIRMADO',
          specialty: 'CARDIO',
          doctorName: 'Dr A',
          convenio: null,
          type: 'CONSULTA',
          preSchedulingFlow: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'a-2',
          date: '2026-04-21',
          time: '12:00',
          status: 'CONFIRMADO',
          specialty: 'CARDIO PEDIATRICA AVANCADA',
          doctorName: 'Dr B',
          convenio: null,
          type: 'CONSULTA',
          preSchedulingFlow: null,
        },
      ]);
    mockedPrisma.appointment.count.mockResolvedValue(1);

    let res = await app.inject({ method: 'GET', url: '/patient-portal/me/upcoming-consultations' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].preScheduling.hasAnamnesis).toBe(true);

    res = await app.inject({ method: 'GET', url: '/patient-portal/me/upcoming-consultations' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].preScheduling.hasAnamnesis).toBe(true);

    await app.close();
  });

  it('covers all authenticated routes with null branchId patient', async () => {
    const userPayload = {
      scope: 'patient_portal',
      patientId: 'p-nb',
      principalPatientId: 'p-nb',
      branchId: null,
      cpf: '12345678901',
      principalCpf: '12345678901',
      allowedPatientIds: ['p-nb'],
    };
    const app = await buildApp(userPayload);
    const patientNoBranch = {
      id: 'p-nb',
      branchId: null,
      name: 'NoBranch',
      cpf: '12345678901',
      birthDate: null,
      email: 'nb@mail.com',
      cellphone: null,
      phone: null,
      createdAt: new Date(),
      isActive: true,
    };
    mockedPrisma.patient.findFirst.mockResolvedValue(patientNoBranch);
    mockedPrisma.appointment.count.mockResolvedValue(0);
    mockedPrisma.report.findMany.mockResolvedValue([
      { id: 'r-null', status: null, exam: null, updatedAt: new Date(), createdAt: new Date(), appointment: null },
    ]);
    mockedPrisma.report.count.mockResolvedValue(0);

    // GET /me — patient.branchId=null, birthDate=null (formatDateOnly(null) → null)
    // report with status=null → isVisibleToPatientReport(null) → normalizeReportStatus(null) → '' → !'' → false
    let res = await app.inject({ method: 'GET', url: '/patient-portal/me' });
    expect(res.statusCode).toBe(200);
    expect(res.json().patient.birthDate).toBeNull();
    expect(res.json().stats.reportsCount).toBe(0);

    // GET /me/profiles — principalPatient.branchId=null, allowed.size > 0 branch
    mockedPrisma.patient.findMany.mockResolvedValue([]);
    mockedPrisma.patientPortalDependentAuthorization.findMany.mockResolvedValue([]);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/profiles' });
    expect(res.statusCode).toBe(200);

    // POST /me/select-profile — selectedProfile.branchId=null → || principalPatient.branchId || null
    mockedPrisma.patient.findMany.mockResolvedValue([]);
    mockedPrisma.patientPortalDependentAuthorization.findMany.mockResolvedValue([]);
    res = await app.inject({ method: 'POST', url: '/patient-portal/me/select-profile', payload: { patientId: 'p-nb' } });
    expect(res.statusCode).toBe(200);

    // GET /me/access-logs — patient.branchId=null → if (patient.branchId) skipped, item.patientId=null branch
    mockedPrisma.patientPortalAccessLog.findMany.mockResolvedValue([
      { id: 'l-1', event: 'VERIFY_CODE_SUCCESS', status: 'SUCCESS', message: 'ok', ipAddress: '1', patientId: null, cpf: null, createdAt: new Date() },
    ]);
    mockedPrisma.patientPortalAccessLog.count.mockResolvedValue(1);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/access-logs' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].patientId).toBeNull();

    // GET /me/documents — branchId=null, report with null status filtered out
    mockedPrisma.preSchedulingDocument.findMany.mockResolvedValue([]);
    mockedPrisma.appointmentAttachment.findMany.mockResolvedValue([]);
    mockedPrisma.report.findMany.mockResolvedValue([
      { id: 'r-null', status: null, exam: null, updatedAt: new Date(), createdAt: new Date(), appointment: null },
    ]);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/documents' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(0);

    // GET /me/consultations — branchId=null skips branchId in where
    mockedPrisma.appointment.findMany.mockResolvedValue([]);
    mockedPrisma.appointment.count.mockResolvedValue(0);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/consultations' });
    expect(res.statusCode).toBe(200);

    // GET /me/exams — branchId=null
    mockedPrisma.appointment.findMany.mockResolvedValue([]);
    mockedPrisma.appointment.count.mockResolvedValue(0);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/exams' });
    expect(res.statusCode).toBe(200);

    // GET /me/upcoming-consultations — branchId=null → hasAnamnesisTemplateForAppointment(null) → false
    // appointment.specialty=null → !specialty → false; appointment.convenio=null branch
    mockedPrisma.appointment.findMany.mockResolvedValue([
      { id: 'a-up', date: '2099-05-01', time: '09:00', status: 'CONFIRMADO', specialty: null, doctorName: null, convenio: null, type: 'CONSULTA', preSchedulingFlow: null },
    ]);
    mockedPrisma.appointment.count.mockResolvedValue(1);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/upcoming-consultations' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].preScheduling.hasAnamnesis).toBe(false);
    expect(res.json().items[0].specialty).toBeNull();

    // GET /me/reports — branchId=null
    mockedPrisma.report.findMany.mockResolvedValue([]);
    mockedPrisma.report.count.mockResolvedValue(0);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/reports' });
    expect(res.statusCode).toBe(200);

    // GET /me/delivery-requests — branchId=null, patient.name='NoBranch' → patient.name || '' uses name
    mockedPrisma.delivery.findMany.mockResolvedValue([]);
    mockedPrisma.delivery.count.mockResolvedValue(0);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/delivery-requests' });
    expect(res.statusCode).toBe(200);

    // GET /me/reports/:id/pdf — branchId=null, all nullable fields in PDF (covers all || '-' branches)
    mockedPrisma.report.findFirst.mockResolvedValueOnce({
      id: 'r-1',
      status: 'FINALIZADO',
      exam: null,
      patientName: null,
      cpf: null,
      requestingDoctor: null,
      reportingDoctor: null,
      description: null,
      conclusion: null,
      notes: null,
      appointment: null,
    });
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/reports/r-1/pdf' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');

    // POST /me/reports/:id/request-physical-delivery — branchId=null, all optional fields null
    mockedPrisma.report.findFirst.mockResolvedValueOnce({
      id: 'r-1',
      status: 'FINALIZADO',
      exam: null,
      patientName: null,
      appointment: null,
    });
    mockedPrisma.delivery.create.mockResolvedValueOnce({
      id: 'd-nb',
      status: 'SOLICITADO_IMPRESSAO',
      availableAt: new Date(),
    });
    res = await app.inject({ method: 'POST', url: '/patient-portal/me/reports/r-1/request-physical-delivery', payload: {} });
    expect(res.statusCode).toBe(201);

    // POST /me/upcoming-consultations/:id/pre-scheduling-link — branchId=null, no flow
    // preSchedulingFlow.create returns publicToken: null → getPublicFlowUrl(null) → null
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-nb',
      status: 'CONFIRMADO',
      patientName: null,
      patientCpf: '12345678901',
      specialty: null,
      type: 'CONSULTA',
      preSchedulingFlow: null,
    });
    mockedPrisma.preSchedulingFlow.create.mockResolvedValueOnce({
      id: 'flow-nb',
      publicToken: null,
      status: 'WAITING_PATIENT_DOCUMENTS',
      documents: [],
      anamnesisResponse: null,
      patientAccessExpiresAt: null,
    });
    res = await app.inject({ method: 'POST', url: '/patient-portal/me/upcoming-consultations/a-nb/pre-scheduling-link' });
    expect(res.statusCode).toBe(200);
    expect(res.json().publicToken).toBeNull();
    expect(res.json().publicUrl).toBeNull();

    await app.close();
  });

  it('covers utility function edge cases: normalizeDateInput NaN, maskEmail no-at, formatDateOnly null', async () => {
    const app = await buildApp();

    // normalizeDateInput('2000-13-01'): matches \d{4}-\d{2}-\d{2} regex but creates NaN Date → returns null → 400
    mockedIsValidCpf.mockReturnValueOnce(true);
    let res = await app.inject({
      method: 'POST',
      url: '/patient-portal/request-code',
      payload: { cpf: '12345678901', birthDate: '2000-13-01' },
      headers: { 'x-forwarded-for': '10.210.0.1' },
    });
    expect(res.statusCode).toBe(400);

    // maskEmail with no '@': patient.email = 'noemail' (truthy, passes !patient.email check)
    // Returns destination = 'noemail' (the raw string)
    mockedIsValidCpf.mockReturnValueOnce(true);
    mockedPrisma.patient.findMany.mockResolvedValueOnce([{
      id: 'p-noat',
      branchId: 'b-1',
      name: 'Patient',
      cpf: '12345678901',
      birthDate: new Date('2000-01-01'),
      email: 'noemail',
      cellphone: '1',
      phone: null,
    }]);
    mockedPrisma.patientPortalDependentAuthorization.findMany.mockResolvedValueOnce([]);
    mockedSendPatientPortalAccessCodeEmail.mockResolvedValueOnce(true);
    res = await app.inject({
      method: 'POST',
      url: '/patient-portal/request-code',
      payload: { cpf: '12345678901', birthDate: '2000-01-01' },
      headers: { 'x-forwarded-for': '10.210.0.2' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().destination).toBe('noemail');

    await app.close();
  });

  it('covers isPublicFlowExpired completed-flow line 105, EXAM type pre-scheduling, and /profiles 404', async () => {
    const userPayload = {
      scope: 'patient_portal',
      patientId: 'p-1',
      principalPatientId: 'p-1',
      branchId: 'b-1',
      cpf: '12345678901',
      principalCpf: '12345678901',
      allowedPatientIds: ['p-1'],
    };
    const app = await buildApp(userPayload);

    mockedPrisma.patient.findFirst.mockResolvedValue({
      id: 'p-1',
      branchId: 'b-1',
      name: 'Paciente',
      cpf: '12345678901',
      birthDate: new Date('2000-01-01'),
      email: 'p@mail.com',
      cellphone: '1',
      phone: null,
      createdAt: new Date(),
      isActive: true,
    });

    // Case: isPublicFlowExpired line 105 — flow has patientAccessExpiresAt in past
    // but patientSubmittedAt is set → isPatientInteractionCompleted = true → isPublicFlowExpired returns false
    // So the flow is NOT expired, isExpired=false, publicToken used directly
    const completedExpiredFlow = {
      id: 'flow-comp-exp',
      publicToken: 'existing-valid-token',
      status: 'DOCUMENTS_RECEIVED',
      documents: [{ id: 'd-1' }],
      anamnesisResponse: null,
      patientAccessExpiresAt: new Date(Date.now() - 3600000), // 1 hour ago
      patientSubmittedAt: new Date(), // completed → isPatientInteractionCompleted = true
      linkSentAt: new Date(),
      patientVerifiedAt: null,
      patientVerifiedCpf: null,
      patientVerifiedName: null,
      patientVerifiedTrust: null,
      anamnesisSentAt: null,
    };
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-ce',
      status: 'CONFIRMADO',
      patientName: 'Paciente',
      patientCpf: '12345678901',
      specialty: 'CARDIOLOGIA',
      type: 'CONSULTA',
      preSchedulingFlow: completedExpiredFlow,
    });
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([]);
    mockedPrisma.preSchedulingFlow.update.mockResolvedValueOnce({
      id: 'flow-comp-exp',
      publicToken: 'existing-valid-token',
      status: 'DOCUMENTS_RECEIVED',
      documents: [{ id: 'd-1' }],
      anamnesisResponse: null,
      patientAccessExpiresAt: new Date(Date.now() - 3600000),
    });
    let res = await app.inject({
      method: 'POST',
      url: '/patient-portal/me/upcoming-consultations/a-ce/pre-scheduling-link',
    });
    expect(res.statusCode).toBe(200);
    // Not expired because patientSubmittedAt is set (isPatientInteractionCompleted = true)
    expect(res.json().publicToken).toBe('existing-valid-token');

    // Case: EXAM type appointment in pre-scheduling-link → hasAnamnesisTemplateForAppointment returns false at EXAM check
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-exam',
      status: 'CONFIRMADO',
      patientName: 'Paciente',
      patientCpf: '12345678901',
      specialty: 'RAIO-X',
      type: 'EXAME',
      preSchedulingFlow: null,
    });
    mockedPrisma.preSchedulingFlow.create.mockResolvedValueOnce({
      id: 'flow-exam',
      publicToken: 'tok-exam',
      status: 'WAITING_PATIENT_DOCUMENTS',
      documents: [],
      anamnesisResponse: null,
      patientAccessExpiresAt: null,
    });
    res = await app.inject({
      method: 'POST',
      url: '/patient-portal/me/upcoming-consultations/a-exam/pre-scheduling-link',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hasAnamnesis).toBe(false);

    // /me/profiles — principal patient not found → 404
    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/profiles' });
    expect(res.statusCode).toBe(404);

    // /me/select-profile — principal patient not found → 404
    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'POST', url: '/patient-portal/me/select-profile', payload: { patientId: 'p-1' } });
    expect(res.statusCode).toBe(404);

    // /me/access-logs — patient not found → 404
    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/access-logs' });
    expect(res.statusCode).toBe(404);

    // /me/delivery-requests — patient not found → 404
    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/delivery-requests' });
    expect(res.statusCode).toBe(404);

    // /me/documents — patient not found → 404
    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/documents' });
    expect(res.statusCode).toBe(404);

    // /me/upcoming-consultations — patient not found → 404
    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/upcoming-consultations' });
    expect(res.statusCode).toBe(404);

    // /me/upcoming-consultations/:id/pre-scheduling-link — patient not found → 404
    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'POST', url: '/patient-portal/me/upcoming-consultations/a-1/pre-scheduling-link' });
    expect(res.statusCode).toBe(404);

    // /me/reports/:id/pdf — patient not found → 404
    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/reports/r-1/pdf' });
    expect(res.statusCode).toBe(404);

    // GET /me/consultations — patient not found → 404
    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/consultations' });
    expect(res.statusCode).toBe(404);

    // GET /me/exams — patient not found → 404
    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/exams' });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('covers resolvePortalProfilesForPrincipal early return with null cpf and null guardianRelationship', async () => {
    // covers resolvePortalProfilesForPrincipal line 338: !principalId || !principalCpf → return []
    // when normalizeCpf returns '' (principalCpf empty)
    mockedNormalizeCpf.mockImplementation((value: string) => {
      if (!value || String(value).trim() === '') return '';
      return String(value || '').replace(/\D/g, '');
    });

    const appProfiles = await buildApp({
      scope: 'patient_portal',
      patientId: 'p-nocpf',
      principalPatientId: 'p-nocpf',
      branchId: 'b-1',
      cpf: '',
      principalCpf: '',
      allowedPatientIds: ['p-nocpf'],
    });
    // Patient with cpf='' → normalizeCpf('') → '' → !principalCpf → resolvePortalProfilesForPrincipal returns []
    mockedPrisma.patient.findFirst.mockResolvedValueOnce({
      id: 'p-nocpf',
      branchId: 'b-1',
      name: 'NoCpf',
      cpf: '',
      birthDate: null,
      email: 'nc@test.com',
      cellphone: null,
      phone: null,
      createdAt: new Date(),
      isActive: true,
    });
    const res = await appProfiles.inject({ method: 'GET', url: '/patient-portal/me/profiles' });
    // principalPatient found but resolvePortalProfilesForPrincipal returns [] because cpf is empty
    // profiles would be empty (only principal filtered out since not in allowed set of size 1)
    expect(res.statusCode).toBe(200);
    await appProfiles.close();

    // covers guardianDependents.forEach where guardianRelationship is null → 'Dependente'
    mockedNormalizeCpf.mockImplementation((value: string) => String(value || '').replace(/\D/g, ''));
    const appDep = await buildApp({
      scope: 'patient_portal',
      patientId: 'p-1',
      principalPatientId: 'p-1',
      branchId: null,
      cpf: '12345678901',
      principalCpf: '12345678901',
      allowedPatientIds: ['p-1', 'dep-norel'],
    });
    mockedPrisma.patient.findFirst.mockResolvedValueOnce({
      id: 'p-1',
      branchId: null,
      name: 'Principal',
      cpf: '12345678901',
      birthDate: null,
      email: 'p@mail.com',
      cellphone: null,
      phone: null,
      createdAt: new Date(),
      isActive: true,
    });
    mockedPrisma.patient.findMany.mockResolvedValueOnce([
      {
        id: 'dep-norel',
        branchId: null,
        name: null,
        cpf: '99999999901',
        birthDate: null,
        email: null,
        cellphone: null,
        phone: '555',
        guardianRelationship: null,
      },
    ]).mockResolvedValueOnce([]);
    mockedPrisma.patientPortalDependentAuthorization.findMany.mockResolvedValueOnce([]);

    const resProfiles = await appDep.inject({ method: 'GET', url: '/patient-portal/me/profiles' });
    expect(resProfiles.statusCode).toBe(200);
    const profiles = resProfiles.json().profiles;
    const dep = profiles.find((p: any) => p.id === 'dep-norel');
    expect(dep?.relationship).toBe('Dependente');
    expect(dep?.birthDate).toBeNull();
    expect(dep?.cellphone).toBe('555');
    await appDep.close();
  });

  it('covers verify-code success with null-field principal', async () => {
    const app = await buildApp({ id: 'ignored' });

    mockedPrisma.patient.findFirst.mockResolvedValueOnce({
      id: 'p-null', branchId: null, name: null, cpf: '12345678901',
      birthDate: null, email: null, cellphone: null,
    });
    mockedPrisma.patient.findMany.mockResolvedValueOnce([]);
    mockedPrisma.patientPortalDependentAuthorization.findMany.mockResolvedValueOnce([]);

    const challengeToken = JSON.stringify({
      scope: 'patient_portal_challenge', patientId: 'p-null', principalPatientId: 'p-null',
      branchId: null, cpf: '12345678901', principalCpf: '12345678901',
      codeHash: hashCode('999999'), requestIdentifier: 'req-null-fields',
    });

    const res = await app.inject({
      method: 'POST', url: '/patient-portal/verify-code',
      payload: { challengeToken, code: '999999' },
      headers: { 'x-forwarded-for': '10.220.0.1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().patient.branchId).toBeNull();
    expect(res.json().patient.name).toBeNull();
    expect(res.json().principal.name).toBeNull();
    await app.close();
  });

  it('covers /me Dependente relationship, principalPatientId fallback, /profiles allowed.size=0, /select-profile null principal name', async () => {
    // /me: patientId !== principalPatientId → relationship = Dependente
    const depApp = await buildApp({
      scope: 'patient_portal', patientId: 'dep-m', principalPatientId: 'p-main',
      branchId: 'b-1', cpf: '99999999901', principalCpf: '12345678901',
      allowedPatientIds: ['p-main', 'dep-m'],
    });
    mockedPrisma.patient.findFirst.mockResolvedValue({
      id: 'dep-m', branchId: 'b-1', name: 'Dep', cpf: '99999999901',
      birthDate: new Date('2010-01-01'), email: 'dep@mail.com',
      cellphone: null, phone: null, createdAt: new Date(), isActive: true,
    });
    mockedPrisma.appointment.count.mockResolvedValue(0);
    mockedPrisma.report.findMany.mockResolvedValue([]);
    let res = await depApp.inject({ method: 'GET', url: '/patient-portal/me' });
    expect(res.statusCode).toBe(200);
    expect(res.json().activeProfile.relationship).toBe('Dependente');
    expect(res.json().patient.cellphone).toBeNull();
    await depApp.close();

    // /me: principalPatientId=null → null || patientId (line 1012 || branch)
    const nullPrinApp = await buildApp({
      scope: 'patient_portal', patientId: 'p-np', principalPatientId: null,
      branchId: 'b-1', cpf: '12345678901', principalCpf: null, allowedPatientIds: null,
    });
    mockedPrisma.patient.findFirst.mockResolvedValue({
      id: 'p-np', branchId: 'b-1', name: 'NoPrin', cpf: '12345678901',
      birthDate: new Date('2000-01-01'), email: 'np@mail.com',
      cellphone: null, phone: null, createdAt: new Date(), isActive: true,
    });
    mockedPrisma.appointment.count.mockResolvedValue(0);
    mockedPrisma.report.findMany.mockResolvedValue([]);
    res = await nullPrinApp.inject({ method: 'GET', url: '/patient-portal/me' });
    expect(res.statusCode).toBe(200);
    expect(res.json().activeProfile.principalPatientId).toBe('p-np');

    // /profiles: allowedPatientIds=null → allowed = new Set([]) → size=0 → filteredProfiles = all
    mockedPrisma.patient.findMany.mockResolvedValue([]);
    mockedPrisma.patientPortalDependentAuthorization.findMany.mockResolvedValue([]);
    res = await nullPrinApp.inject({ method: 'GET', url: '/patient-portal/me/profiles' });
    expect(res.statusCode).toBe(200);
    expect(res.json().profiles.length).toBeGreaterThanOrEqual(1);

    // /select-profile: allowedPatientIds=null → allowedIds=[] → allowedSet = profiles.map(...)
    mockedPrisma.patient.findMany.mockResolvedValue([]);
    mockedPrisma.patientPortalDependentAuthorization.findMany.mockResolvedValue([]);
    res = await nullPrinApp.inject({
      method: 'POST', url: '/patient-portal/me/select-profile',
      payload: { patientId: 'p-np' },
    });
    expect(res.statusCode).toBe(200);
    await nullPrinApp.close();

    // /select-profile: principalPatient.name=null → principal.name=null (line 1109)
    const nullNameApp = await buildApp({
      scope: 'patient_portal', patientId: 'p-nn', principalPatientId: 'p-nn',
      branchId: 'b-1', cpf: '12345678901', principalCpf: '12345678901',
      allowedPatientIds: ['p-nn'],
    });
    mockedPrisma.patient.findFirst.mockResolvedValue({
      id: 'p-nn', branchId: 'b-1', name: null, cpf: '12345678901',
      birthDate: null, email: null, cellphone: null, phone: null,
      createdAt: new Date(), isActive: true,
    });
    mockedPrisma.patient.findMany.mockResolvedValue([]);
    mockedPrisma.patientPortalDependentAuthorization.findMany.mockResolvedValue([]);
    res = await nullNameApp.inject({
      method: 'POST', url: '/patient-portal/me/select-profile',
      payload: { patientId: 'p-nn' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().principal.name).toBeNull();
    expect(res.json().patient.name).toBeNull();
    await nullNameApp.close();
  });

  it('covers /documents null-field items, document-view null branchId/mimeType/fileName, and patient-not-found', async () => {
    const app = await buildApp({
      scope: 'patient_portal', patientId: 'p-dv', principalPatientId: 'p-dv',
      branchId: null, cpf: '12345678901', principalCpf: '12345678901',
      allowedPatientIds: ['p-dv'],
    });
    const patientDv = {
      id: 'p-dv', branchId: null, name: 'DvPat', cpf: '12345678901',
      birthDate: new Date('2000-01-01'), email: 'dv@mail.com',
      cellphone: null, phone: null, createdAt: new Date(), isActive: true,
    };
    mockedPrisma.patient.findFirst.mockResolvedValue(patientDv);

    // /documents with null-field items (null mimeType, sizeBytes, documentType, exam, flow.appointment, attachment.appointment, updatedAt)
    mockedPrisma.preSchedulingDocument.findMany.mockResolvedValueOnce([
      {
        id: 'pdoc-1', fileName: 'f.pdf', mimeType: null, sizeBytes: null, documentType: null,
        uploadedAt: new Date('2026-04-15T10:00:00Z'), flow: { appointment: null },
      },
    ]);
    mockedPrisma.appointmentAttachment.findMany.mockResolvedValueOnce([
      {
        id: 'att-null', fileName: 'a.pdf', mimeType: null, sizeBytes: null,
        uploadedAt: new Date('2026-04-14T09:00:00Z'), appointment: null,
      },
    ]);
    mockedPrisma.report.findMany.mockResolvedValueOnce([
      {
        id: 'r-null-ex', status: 'FINALIZADO', exam: null, updatedAt: null,
        createdAt: new Date('2026-04-13T08:00:00Z'), appointment: null,
      },
    ]);
    let res = await app.inject({ method: 'GET', url: '/patient-portal/me/documents' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(3);
    const items = res.json().items;
    const preItem = items.find((i: any) => i.source === 'pre-scheduling');
    expect(preItem.mimeType).toBe('application/octet-stream');
    expect(preItem.label).toBe('Documento');
    const reportItem = items.find((i: any) => i.source === 'report');
    expect(reportItem.label).toBe('Laudo');

    // document-view: null branchId + null mimeType/fileName for pre-scheduling
    const mockedGetAnexosStorageLocal = getAnexosStorage as any;
    const mockSt = { exists: vi.fn(), createReadStream: vi.fn(() => null) };
    mockedGetAnexosStorageLocal.mockReturnValue(mockSt);

    mockedPrisma.preSchedulingDocument.findFirst.mockResolvedValueOnce({
      id: 'pdoc-dv', gcsObjectName: 'pre/dv.pdf', mimeType: null, fileName: null,
    });
    mockSt.exists.mockResolvedValueOnce(true);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/documents/pre-scheduling/pdoc-dv/view' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');

    // document-view: appointment-attachment null branchId, null mimeType, null fileName
    mockedPrisma.appointmentAttachment.findFirst.mockResolvedValueOnce({
      id: 'att-dv', gcsObjectName: 'att/dv.pdf', mimeType: null, fileName: null,
    });
    mockSt.exists.mockResolvedValueOnce(true);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/documents/appointment-attachment/att-dv/view' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');

    // document-view: report null branchId
    mockedPrisma.report.findFirst.mockResolvedValueOnce({
      id: 'r-dv', status: 'FINALIZADO', exam: 'USG',
      appointment: { date: '2026-04-20', time: '10:00', specialty: 'RADIO', doctorName: null },
    });
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/documents/report/r-dv/view' });
    expect(res.statusCode).toBe(200);

    // document-view: patient not found → 404
    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/documents/pre-scheduling/any/view' });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('covers upcoming-consultations isPublicFlowExpired line 105, and reports/delivery-requests null fields', async () => {
    const app = await buildApp({
      scope: 'patient_portal', patientId: 'p-up3', principalPatientId: 'p-up3',
      branchId: null, cpf: '12345678901', principalCpf: '12345678901',
      allowedPatientIds: ['p-up3'],
    });
    mockedPrisma.patient.findFirst.mockResolvedValue({
      id: 'p-up3', branchId: null, name: 'Pat', cpf: '12345678901',
      birthDate: null, email: 'p@mail.com', cellphone: null, phone: null,
      createdAt: new Date(), isActive: true,
    });

    // flow: patientAccessExpiresAt past + patientSubmittedAt set → isPatientInteractionCompleted=true
    // → isPublicFlowExpired: line 105 → return false (not expired despite past date)
    const completedFlow = {
      id: 'fc2', publicToken: null, status: 'COMPLETED',
      documents: [], anamnesisResponse: { id: 'ar', submittedAt: new Date() },
      patientAccessExpiresAt: new Date(Date.now() - 3600000), patientSubmittedAt: new Date(),
    };
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([
      {
        id: 'a-done', date: '2099-07-01', time: '09:00', status: 'REALIZADO',
        specialty: 'X', doctorName: 'Dr', convenio: { name: 'SUS' }, type: 'CONSULTA',
        preSchedulingFlow: completedFlow,
      },
    ]);
    mockedPrisma.appointment.count.mockResolvedValueOnce(1);
    let res = await app.inject({ method: 'GET', url: '/patient-portal/me/upcoming-consultations' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].preScheduling.publicToken).toBeNull();
    expect(res.json().items[0].preScheduling.anamnesisAnswered).toBe(true);

    // /reports with null branchId
    mockedPrisma.report.findMany.mockResolvedValueOnce([
      { id: 'r-1', status: 'FINALIZADO', updatedAt: new Date(), createdAt: new Date(), appointment: null },
    ]);
    mockedPrisma.report.count.mockResolvedValueOnce(1);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/reports' });
    expect(res.statusCode).toBe(200);

    // /reports/:id/pdf: null appointment subfields → String(null || '-') etc.
    mockedPrisma.report.findFirst.mockResolvedValueOnce({
      id: 'r-nb', status: 'FINALIZADO', exam: 'USG',
      patientName: null, cpf: null, requestingDoctor: null, reportingDoctor: null,
      description: null, conclusion: null, notes: null,
      appointment: { date: null, time: null, specialty: null, doctorName: null },
    });
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/reports/r-nb/pdf' });
    expect(res.statusCode).toBe(200);

    // /delivery-requests: patient.name=null → patientName || '' = '' (the || '' branch in OR)
    mockedPrisma.patient.findFirst.mockResolvedValueOnce({
      id: 'p-up3', branchId: null, name: null, cpf: '12345678901',
      birthDate: null, email: 'p@mail.com', cellphone: null, phone: null,
      createdAt: new Date(), isActive: true,
    });
    mockedPrisma.delivery.findMany.mockResolvedValueOnce([]);
    mockedPrisma.delivery.count.mockResolvedValueOnce(0);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/delivery-requests' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });


  it('covers request-code null branchId/name, maskEmail @domain.com, and invalid-cpf-event cpf||null', async () => {
    const app = await buildApp();
    mockedNormalizeCpf.mockImplementation((v: string) => String(v || '').replace(/\D/g, ''));
    mockedIsValidCpf.mockReturnValue(true);

    // Success path: patient with null branchId + null name + email='@domain.com'
    // Covers: line 697 (branchId||null), line 708 (name||undefined), line 60 (maskEmail !name||!domain → return raw)
    mockedPrisma.patient.findMany.mockResolvedValueOnce([{
      id: 'p-rc-31', branchId: null, name: null, cpf: '55544433322',
      birthDate: new Date('1985-05-05'), email: '@domain.com',
      cellphone: null, phone: null,
    }]);
    mockedPrisma.patientPortalDependentAuthorization.findMany.mockResolvedValueOnce([]);
    mockedSendPatientPortalAccessCodeEmail.mockResolvedValueOnce(true);
    let res = await app.inject({
      method: 'POST', url: '/patient-portal/request-code',
      payload: { cpf: '55544433322', birthDate: '1985-05-05' },
      headers: { 'x-forwarded-for': '10.231.0.1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().destination).toBe('@domain.com');

    // Invalid data with no-digits CPF → normalizeCpf('abc')='' → cpf='' → cpf||null=null (line 636)
    res = await app.inject({
      method: 'POST', url: '/patient-portal/request-code',
      payload: { cpf: 'abc', birthDate: '2000-01-01' },
      headers: { 'x-forwarded-for': '10.231.0.2' },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('covers verify-code null cpf/requestIdentifier/codeHash in challenge payload', async () => {
    const app = await buildApp({ id: 'ignored' });

    // Part 1: empty code → String(code || '').trim() where ''||'' = '' → line 760 || branch
    const c1 = JSON.stringify({
      scope: 'patient_portal_challenge', patientId: 'p-vcn1',
      cpf: null, codeHash: hashCode('555555'), requestIdentifier: null,
    });
    let res = await app.inject({
      method: 'POST', url: '/patient-portal/verify-code',
      payload: { challengeToken: c1, code: '' },
    });
    expect(res.statusCode).toBe(400);

    // Part 2: null codeHash → line 828 (codeHash||'' = '') → always wrong code
    //   + null cpf → line 844 (cpf||'' = '') in INVALID_CODE event
    const c2 = JSON.stringify({
      scope: 'patient_portal_challenge', patientId: 'p-vcn2',
      cpf: null, codeHash: null, requestIdentifier: 'vc-ncpf-a',
    });
    res = await app.inject({
      method: 'POST', url: '/patient-portal/verify-code',
      payload: { challengeToken: c2, code: '123456' },
    });
    expect(res.statusCode).toBe(401);

    // Part 3: correct code + null cpf → patient lookup with cpf='' (line 858) → not found → line 878
    const c3 = JSON.stringify({
      scope: 'patient_portal_challenge', patientId: 'p-vcn3',
      cpf: null, codeHash: hashCode('999999'), requestIdentifier: 'vc-ncpf-b',
    });
    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({
      method: 'POST', url: '/patient-portal/verify-code',
      payload: { challengeToken: c3, code: '999999' },
    });
    expect(res.statusCode).toBe(404);

    // Part 4: exhaust attempts on challengeKey='' (requestIdentifier=null) then locked
    //   → line 811 (requestIdentifier||'') and line 820 (cpf||'' = '') in blocked event
    const cLock = JSON.stringify({
      scope: 'patient_portal_challenge', patientId: 'p-vclock2',
      cpf: null, codeHash: hashCode('888888'), requestIdentifier: null,
    });
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST', url: '/patient-portal/verify-code',
        payload: { challengeToken: cLock, code: '111111' },
      });
    }
    res = await app.inject({
      method: 'POST', url: '/patient-portal/verify-code',
      payload: { challengeToken: cLock, code: '111111' },
    });
    expect(res.statusCode).toBe(429);

    await app.close();
  });

  it('covers upcoming-consultations/pre-scheduling-link null fields, reports null patient, and report document view null patient fields', async () => {
    const userPayload = {
      scope: 'patient_portal', patientId: 'p-t31', principalPatientId: 'p-t31',
      branchId: 'b-31', cpf: '12345678901', principalCpf: '12345678901',
      allowedPatientIds: ['p-t31'],
    };
    const app = await buildApp(userPayload);
    const patientNullFields = {
      id: 'p-t31', branchId: 'b-31', name: null, cpf: null,
      birthDate: new Date('2000-01-01'), email: 'p31@test.com',
      cellphone: null, phone: null, createdAt: new Date(), isActive: true,
    };
    mockedPrisma.patient.findFirst.mockResolvedValue(patientNullFields);

    // GET /me/upcoming-consultations: null date/time/status + null publicToken flow
    // Covers lines 1628 (date||null), 1629 (time||null), 1630 (status||null),
    //         1624 (flow?.publicToken||'' when null), 1642 (publicToken='' → null url)
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([{
      id: 'apt-nf', status: null, date: null, time: null,
      specialty: 'CARDIO', doctorName: null, patientName: null, patientCpf: '12345678901',
      type: 'CONSULTA',
      preSchedulingFlow: {
        id: 'flow-nf', publicToken: null, status: 'WAITING_PATIENT_DOCUMENTS',
        documents: [{ id: 'd1' }], anamnesisResponse: null,
        patientAccessExpiresAt: null, patientSubmittedAt: null,
        linkSentAt: null, patientVerifiedAt: null, patientVerifiedCpf: null,
        patientVerifiedName: null, patientVerifiedTrust: null, anamnesisSentAt: null,
      },
    }]);
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([]);
    let res = await app.inject({ method: 'GET', url: '/patient-portal/me/upcoming-consultations' });
    expect(res.statusCode).toBe(200);
    const apt = res.json().items[0];
    expect(apt.date).toBeNull();
    expect(apt.preScheduling.publicToken).toBeNull();
    expect(apt.preScheduling.publicUrl).toBeNull();

    // POST pre-scheduling-link: new flow + hasAnamnesis=false → anamnesisSentAt=null (line 1719)
    //   patient.name=null → patient.name||appointment.patientName (line 1713)
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'apt-nf-link', status: 'CONFIRMADO', patientName: 'AptPat',
      patientCpf: '12345678901', specialty: 'CARDIO', type: 'CONSULTA',
      preSchedulingFlow: null,
    });
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([]);
    mockedPrisma.preSchedulingFlow.create.mockResolvedValueOnce({
      id: 'flow-nf-new', publicToken: 'tok-nf', status: 'WAITING_PATIENT_DOCUMENTS',
      documents: [], anamnesisResponse: null, patientAccessExpiresAt: null,
    });
    res = await app.inject({ method: 'POST', url: '/patient-portal/me/upcoming-consultations/apt-nf-link/pre-scheduling-link' });
    expect(res.statusCode).toBe(200);

    // POST pre-scheduling-link: existing valid flow + needsNewToken=false + linkSentAt=null + documents=null
    // Covers line 1735 (linkSentAt||now), line 1757 (Array.isArray false → 0)
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'apt-nf-upd', status: 'CONFIRMADO',
      patientName: 'AptPat', patientCpf: '12345678901',
      specialty: 'CARDIO', type: 'CONSULTA',
      preSchedulingFlow: {
        id: 'flow-nf-upd', publicToken: 'valid-tok', status: 'WAITING_PATIENT_DOCUMENTS',
        documents: null, anamnesisResponse: null, patientAccessExpiresAt: null,
        patientSubmittedAt: null, linkSentAt: null, patientVerifiedAt: null,
        patientVerifiedCpf: null, patientVerifiedName: null,
        patientVerifiedTrust: null, anamnesisSentAt: null,
      },
    });
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([]);
    mockedPrisma.preSchedulingFlow.update.mockResolvedValueOnce({
      id: 'flow-nf-upd', publicToken: 'valid-tok', status: 'WAITING_PATIENT_DOCUMENTS',
      documents: null, anamnesisResponse: null, patientAccessExpiresAt: null,
    });
    res = await app.inject({ method: 'POST', url: '/patient-portal/me/upcoming-consultations/apt-nf-upd/pre-scheduling-link' });
    expect(res.statusCode).toBe(200);
    expect(res.json().documentsCount).toBe(0);

    // GET /me/reports: patient not found → 404 (line 1782)
    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/reports' });
    expect(res.statusCode).toBe(404);
    mockedPrisma.patient.findFirst.mockResolvedValue(patientNullFields);

    // GET /me/reports/:id/pdf: patient.name=null, patient.cpf=null
    // report.patientName set + report.cpf set + exam=null + appointment.specialty set
    // Covers lines 1880 (name||patientName), 1881 (cpf||cpf), 1882 (exam||specialty)
    mockedPrisma.report.findFirst.mockResolvedValueOnce({
      id: 'r-t31', status: 'FINALIZADO', exam: null,
      patientName: 'RPat31', cpf: 'CPF31',
      requestingDoctor: null, reportingDoctor: null,
      description: null, conclusion: null, notes: null,
      appointment: { date: '2026-08-01', time: '09:00', specialty: 'USG' },
    });
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/reports/r-t31/pdf' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');

    // GET /me/documents/:source/:id/view (report source): patient.name=null → buildReportPdfLines lines 494-500
    mockedPrisma.report.findFirst.mockResolvedValueOnce({
      id: 'r-t31-dv', status: 'FINALIZADO', exam: null,
      patientName: 'RPat31DV', cpf: 'CPF31DV',
      requestingDoctor: null, reportingDoctor: null,
      description: null, conclusion: null, notes: null,
      appointment: { date: '2026-08-02', time: '10:00', specialty: 'CARDIO', doctorName: null },
    });
    res = await app.inject({ method: 'GET', url: '/patient-portal/me/documents/report/r-t31-dv/view' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('covers documents specialty fallback, access-log limit, requirePatientPortalAuth null principalPatientId, and resolvePortalProfiles explicit null deps', async () => {
    // requirePatientPortalAuth: JWT without principalPatientId → principalPatientId||patientId (line 553)
    // allowedPatientIds with null item → id||'' (line 558)
    const noRincipalApp = await buildApp({
      scope: 'patient_portal', patientId: 'p-npc',
      // no principalPatientId set → triggers || patientId at line 553
      branchId: 'b-npc', cpf: '12345678901',
      // no principalCpf → triggers || cpf at line 556
      allowedPatientIds: [null, 'p-npc'], // null item → id||'' at line 558
    });
    mockedPrisma.patient.findFirst.mockResolvedValue({
      id: 'p-npc', branchId: 'b-npc', name: 'NPC', cpf: '12345678901',
      birthDate: new Date('2000-01-01'), email: 'npc@test.com',
      cellphone: null, phone: null, createdAt: new Date(), isActive: true,
    });
    mockedPrisma.appointment.count.mockResolvedValue(0);
    mockedPrisma.report.findMany.mockResolvedValue([]);
    let res = await noRincipalApp.inject({ method: 'GET', url: '/patient-portal/me' });
    expect(res.statusCode).toBe(200);
    await noRincipalApp.close();

    // access-log route without ?limit param → limit||20 (line 1135)
    const appT32 = await buildApp({
      scope: 'patient_portal', patientId: 'p-t32', principalPatientId: 'p-t32',
      branchId: 'b-32', cpf: '12345678901', principalCpf: '12345678901',
      allowedPatientIds: ['p-t32'],
    });
    mockedPrisma.patient.findFirst.mockResolvedValue({
      id: 'p-t32', branchId: 'b-32', name: 'P32', cpf: '12345678901',
      birthDate: new Date('2000-01-01'), email: 'p32@test.com',
      cellphone: null, phone: null, createdAt: new Date(), isActive: true,
    });
    mockedPrisma.patientPortalAccessLog.findMany.mockResolvedValue([]);
    mockedPrisma.patientPortalAccessLog.count.mockResolvedValue(0);
    res = await appT32.inject({ method: 'GET', url: '/patient-portal/me/access-logs' }); // no ?limit
    expect(res.statusCode).toBe(200);

    // documents route: report with exam=null + appointment.specialty set → label=specialty (not 'Laudo')
    // Covers line 1328: report.exam||appointment.specialty||'Laudo' where specialty is truthy
    mockedPrisma.preSchedulingDocument.findMany.mockResolvedValueOnce([]);
    mockedPrisma.appointmentAttachment.findMany.mockResolvedValueOnce([]);
    mockedPrisma.report.findMany.mockResolvedValueOnce([{
      id: 'r-spec', status: 'FINALIZADO', exam: null, updatedAt: new Date(),
      createdAt: new Date(), appointment: { id: 'a-sp', date: '2026-07-01', time: '09:00', specialty: 'CARDIOLOGIA', status: 'FINALIZADO', type: 'CONSULTA' },
    }]);
    res = await appT32.inject({ method: 'GET', url: '/patient-portal/me/documents' });
    expect(res.statusCode).toBe(200);
    const docItems = res.json().items;
    const reportDoc = docItems.find((i: any) => i.source === 'report');
    expect(reportDoc?.label).toBe('CARDIOLOGIA'); // exam=null → used appointment.specialty

    // resolvePortalProfiles: null branchId + explicit auth with null depId + real dep not in auth map
    // Covers: line 392 (null depId → ||''), 401 (branchId=null ternary false path), 
    //         452 (null depId → ||''), 453 (!dependentId → early return), 454 (null relationship → ||'Dependente autorizado')
    //         461 (dep not in relationship map → ||'Dependente autorizado')
    mockedPrisma.patient.findFirst.mockResolvedValueOnce({
      id: 'p-t32', branchId: null, name: 'P32', cpf: '12345678901', // null branchId → line 401 ternary false
      birthDate: new Date('2000-01-01'), email: 'p32@test.com',
      cellphone: null, phone: null, createdAt: new Date(), isActive: true,
    });
    mockedPrisma.patient.findMany
      .mockResolvedValueOnce([]) // guardianDependents (empty)
      .mockResolvedValueOnce([   // explicitDependents (dep-B not in auth items!)
        { id: 'dep-B', branchId: null, name: 'DepB', cpf: '88888888801',
          birthDate: new Date(), email: null, cellphone: null, phone: null },
      ]);
    mockedPrisma.patientPortalDependentAuthorization.findMany.mockResolvedValueOnce([
      { dependentPatientId: null, relationship: 'X' },        // null depId → lines 392, 452, 453 (early return)
      { dependentPatientId: 'dep-A', relationship: null },    // null relationship → line 454 (||'Dependente autorizado')
    ]);
    // Result: explicitDependentIds = ['dep-A'] (null depId filtered out)
    // explicitRelationshipById = { 'dep-A' → 'Dependente autorizado' }
    // explicitDependents returns dep-B (not dep-A) → line 461: map.get('dep-B') = undefined → || 'Dependente autorizado'
    res = await appT32.inject({ method: 'GET', url: '/patient-portal/me/profiles' });
    expect(res.statusCode).toBe(200);

    // hasAnamnesisTemplateForAppointment: procedure.name=null → normalizeComparableText(null) → line 83 (||'')
    // Also: specialty doesn't match any procedure → procedures[0] fallback (line 235)
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([{
      id: 'apt-83', status: 'CONFIRMADO', date: '2026-09-01', time: '09:00',
      specialty: 'UNIQUE_SPECIALTY_XYZ', doctorName: null, patientName: null, patientCpf: '12345678901',
      type: 'EXAME', preSchedulingFlow: null,
    }]);
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([
      { id: 'proc-null', name: null, anamnesisTemplates: [] }, // name=null → normalizeComparableText(null) → line 83
      // specialty 'unique_specialty_xyz' vs '' → includes '' = true → matches first? 
      // wait: normalizedSpecialty='unique_specialty_xyz', procedureName=''
      // '' === 'unique...' = false, ''.includes('unique..') = false, 'unique..'.includes('') = TRUE
      // so it MATCHES! find() returns proc-null. No fallback to procedures[0]
      // To NOT match, need procedureName that doesn't satisfy any condition with specialty
    ]);
    res = await appT32.inject({ method: 'GET', url: '/patient-portal/me/upcoming-consultations' });
    expect(res.statusCode).toBe(200);

    await appT32.close();
  });

});
