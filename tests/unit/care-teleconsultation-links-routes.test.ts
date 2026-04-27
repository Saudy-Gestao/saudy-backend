import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import teleconsultationLinksRoutes from '../../src/modules/care/routes/teleconsultation-links';
import prisma from '../../src/modules/care/lib/prisma';

const sendTextMessageMock = vi.fn();

vi.mock('../../src/modules/care/lib/gupshup', () => ({
  default: class MockGupshupService {
    sendTextMessage = sendTextMessageMock;
  },
}));

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    preAttendance: { findFirst: vi.fn(), update: vi.fn() },
    appointment: { findFirst: vi.fn() },
    patient: { findFirst: vi.fn() },
    convenioAuthorizationAttachment: { count: vi.fn() },
    preSchedulingFlow: { findFirst: vi.fn(), updateMany: vi.fn() },
    consultation: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    whatsAppConfig: { findUnique: vi.fn() },
    teleconsultationMessage: { create: vi.fn(), findMany: vi.fn() },
  },
}));

const mockedPrisma = prisma as any;

async function buildApp(opts?: { unauthorized?: boolean; verifyThrows?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1' };
  });
  app.decorate('jwt', {
    sign: vi.fn(() => 'signed-token'),
    verify: vi.fn(() => {
      if (opts?.verifyThrows) throw new Error('invalid');
      return {
        scope: 'teleconsultation_link',
        role: 'PATIENT',
        appointmentId: 'a-1',
        branchId: 'b-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
    }),
  });

  await app.register(teleconsultationLinksRoutes, { prefix: '/tele' });
  return app;
}

describe('care teleconsultation links routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sendTextMessageMock.mockResolvedValue({ status: 'success', messageId: 'mid-1' });

    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b-1' } } });
    mockedPrisma.preAttendance.findFirst.mockResolvedValue({
      id: 'pa-1',
      branchId: 'b-1',
      appointmentId: 'a-1',
      status: 'RECEPCAO_CONCLUIDA',
      fullName: 'Maria',
      phone: '11999990000',
      notes: null,
    });
    mockedPrisma.preAttendance.update.mockResolvedValue({ id: 'pa-1' });
    mockedPrisma.appointment.findFirst.mockResolvedValue({
      id: 'a-1',
      branchId: 'b-1',
      isActive: true,
      type: 'CONSULTA',
      observations: '[MODALIDADE: TELECONSULTA]',
      authorizationStatus: 'AUTHORIZED',
      patientId: 'p-1',
      patientName: 'Maria',
      doctorName: 'Dr A',
      specialty: 'Clínica',
      date: '2026-04-13',
      time: '10:00',
      convenio: 'X',
    });
    mockedPrisma.patient.findFirst.mockResolvedValue({ id: 'p-1', cellphone: '11999990000', phone: '11988887777', name: 'Maria' });
    mockedPrisma.convenioAuthorizationAttachment.count.mockResolvedValue(1);
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValue({
      id: 'f-1',
      appointmentId: 'a-1',
      branchId: 'b-1',
      status: 'PRE_AUTHORIZED',
      preAuthorizedAt: new Date(),
      documents: [{ id: 'd-1' }],
    });
    mockedPrisma.preSchedulingFlow.updateMany.mockResolvedValue({ count: 1 });
    mockedPrisma.consultation.findFirst.mockResolvedValue(null);
    mockedPrisma.consultation.update.mockResolvedValue({ id: 'c-1' });
    mockedPrisma.consultation.create.mockResolvedValue({ id: 'c-1' });
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValue({
      isActive: true,
      accountSid: 'key',
      authToken: 'app',
      fromNumber: '5511999990000',
    });
    mockedPrisma.teleconsultationMessage.create.mockResolvedValue({ id: 'tm-1' });
    mockedPrisma.teleconsultationMessage.findMany.mockResolvedValue([
      {
        id: 'tm-1',
        fromRole: 'PATIENT',
        messageType: 'TEXT',
        text: 'oi',
        fileName: null,
        fileMimeType: null,
        fileSizeBytes: null,
        fileDataUrl: null,
        createdAt: new Date().toISOString(),
      },
    ]);
  });

  it('handles auth and eligibility route', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/tele/pre-attendance/pa-1/eligibility' });
    expect(res.statusCode).toBe(500);
    await unauth.close();

    const app = await buildApp();
    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/tele/pre-attendance/pa-1/eligibility' });
    expect(res.statusCode).toBe(403);

    mockedPrisma.preAttendance.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/tele/pre-attendance/pa-1/eligibility' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.preAttendance.findFirst.mockResolvedValueOnce({
      id: 'pa-1',
      branchId: 'b-1',
      appointmentId: 'a-1',
      status: 'EM_ANDAMENTO',
      fullName: 'Maria',
      phone: '11999990000',
    });
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-1',
      branchId: 'b-1',
      isActive: true,
      type: 'CONSULTA',
      observations: '',
      authorizationStatus: 'PENDING',
    });
    res = await app.inject({ method: 'GET', url: '/tele/pre-attendance/pa-1/eligibility' });
    expect(res.statusCode).toBe(200);
    expect(res.json().canSendLink).toBe(false);
    await app.close();
  });

  it('covers pre-attendance context error in send-whatsapp-link route', async () => {
    const app = await buildApp();

    mockedPrisma.preAttendance.findFirst.mockResolvedValueOnce(null);
    const res = await app.inject({ method: 'POST', url: '/tele/pre-attendance/pa-x/send-whatsapp-link', payload: { notes: 'ok' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('Pré-atendimento não encontrado');

    await app.close();
  });

  it('sends pre-attendance whatsapp link with validations', async () => {
    const app = await buildApp();

    mockedPrisma.preAttendance.findFirst.mockResolvedValueOnce({
      id: 'pa-1',
      branchId: 'b-1',
      appointmentId: 'a-1',
      status: 'EM_ANDAMENTO',
      fullName: 'Maria',
      phone: '11999990000',
    });
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-1',
      branchId: 'b-1',
      isActive: true,
      type: 'CONSULTA',
      observations: '',
      authorizationStatus: 'PENDING',
    });
    let res = await app.inject({ method: 'POST', url: '/tele/pre-attendance/pa-1/send-whatsapp-link', payload: {} });
    expect(res.statusCode).toBe(400);

    mockedPrisma.patient.findFirst.mockResolvedValueOnce({ id: 'p-1', cellphone: '', phone: '', name: 'Maria' });
    mockedPrisma.preAttendance.findFirst.mockResolvedValueOnce({
      id: 'pa-1',
      branchId: 'b-1',
      appointmentId: 'a-1',
      status: 'RECEPCAO_CONCLUIDA',
      fullName: 'Maria',
      phone: '',
      notes: null,
    });
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-1',
      branchId: 'b-1',
      isActive: true,
      type: 'CONSULTA',
      observations: '[MODALIDADE: TELECONSULTA]',
      authorizationStatus: 'AUTHORIZED',
      patientId: 'p-1',
    });
    res = await app.inject({ method: 'POST', url: '/tele/pre-attendance/pa-1/send-whatsapp-link', payload: {} });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/tele/pre-attendance/pa-1/send-whatsapp-link', payload: { notes: 'ok' } });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('sends appointment whatsapp link and supports doctor-only mode', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/tele/appointment/a-1/send-whatsapp-link', payload: { notes: 'ok' } });
    expect(res.statusCode).toBe(200);

    mockedPrisma.patient.findFirst.mockResolvedValueOnce({ id: 'p-1', cellphone: '', phone: '', name: 'Maria' });
    mockedPrisma.preAttendance.findFirst.mockResolvedValueOnce({
      id: 'pa-1',
      branchId: 'b-1',
      appointmentId: 'a-1',
      status: 'RECEPCAO_CONCLUIDA',
      fullName: 'Maria',
      phone: '',
      notes: null,
    });
    res = await app.inject({ method: 'POST', url: '/tele/appointment/a-1/send-whatsapp-link', payload: { sendPatientMessage: true } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/tele/appointment/a-1/send-whatsapp-link', payload: { sendPatientMessage: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json().whatsapp).toBeNull();

    await app.close();
  });

  it('covers appointment context not found, prerequisites errors, and successful patient message', async () => {
    const app = await buildApp();

    // getAppointmentTeleconsultationContext -> appointment not found
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'POST', url: '/tele/appointment/a-missing/send-whatsapp-link', payload: { notes: 'ok' } });
    expect(res.statusCode).toBe(404);

    // prerequisites not met (not teleconsultation + not authorized + flow not pre-authorized)
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-1',
      branchId: 'b-1',
      isActive: true,
      type: 'CONSULTA',
      observations: '',
      authorizationStatus: 'PENDING',
      patientId: 'p-1',
      patientName: 'Maria',
      doctorName: 'Dr A',
      specialty: 'Clínica',
      date: '2026-04-13',
      time: '10:00',
      convenio: 'X',
    });
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1',
      appointmentId: 'a-1',
      branchId: 'b-1',
      status: 'PENDING',
      preAuthorizedAt: null,
      documents: [],
    });
    res = await app.inject({ method: 'POST', url: '/tele/appointment/a-1/send-whatsapp-link', payload: { notes: 'ok' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Pré-requisitos');
    expect(Array.isArray(res.json().reasons)).toBe(true);

    // success with sendPatientMessage=true -> response message uses line 733 branch
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-1',
      branchId: 'b-1',
      isActive: true,
      type: 'CONSULTA',
      observations: '[MODALIDADE: TELECONSULTA]',
      authorizationStatus: 'AUTHORIZED',
      patientId: 'p-1',
      patientName: 'Maria',
      doctorName: 'Dr A',
      specialty: 'Clínica',
      date: '2026-04-13',
      time: '10:00',
      convenio: 'X',
    });
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1',
      appointmentId: 'a-1',
      branchId: 'b-1',
      status: 'PRE_AUTHORIZED',
      preAuthorizedAt: new Date(),
      documents: [{ id: 'd-1' }],
    });
    mockedPrisma.patient.findFirst.mockResolvedValueOnce({ id: 'p-1', cellphone: '11999990000', phone: '11988887777', name: 'Maria' });
    sendTextMessageMock.mockResolvedValueOnce({ status: 'success', messageId: 'mid-ok' });
    res = await app.inject({ method: 'POST', url: '/tele/appointment/a-1/send-whatsapp-link', payload: { notes: 'ok', sendPatientMessage: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toContain('enviado com sucesso');

    await app.close();
  });

  it('handles public signaling/messages/token resolve', async () => {
    const invalidApp = await buildApp({ verifyThrows: true });
    let res = await invalidApp.inject({ method: 'GET', url: '/tele/public?token=x' });
    expect(res.statusCode).toBe(401);

    // verifyPublicToken error path for GET /public/signal and GET /public/messages
    res = await invalidApp.inject({ method: 'GET', url: '/tele/public/signal?token=x' });
    expect(res.statusCode).toBe(401);
    res = await invalidApp.inject({ method: 'GET', url: '/tele/public/messages?token=x' });
    expect(res.statusCode).toBe(401);
      // POST /public/signal with invalid token → covers lines 769-770
      res = await invalidApp.inject({ method: 'POST', url: '/tele/public/signal', payload: { token: 'x', type: 'chat-message', payload: { text: 'hi' } } });
      expect(res.statusCode).toBe(401);
    await invalidApp.close();

    const app = await buildApp();

    res = await app.inject({ method: 'POST', url: '/tele/public/signal', payload: { token: 'x', type: 'invalid' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/tele/public/signal', payload: { token: 'x', type: 'chat-message', payload: { text: '' } } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/tele/public/signal', payload: { token: 'x', type: 'chat-message', payload: { text: 'oi' } } });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: '/tele/public/signal?token=x&lastEventId=0' });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: '/tele/public/messages?token=x' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThan(0);

    res = await app.inject({ method: 'GET', url: '/tele/public/x' });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: '/tele/public?token=x' });
    expect(res.statusCode).toBe(200);

    // verifyPublicToken branch when appointment exists but is not teleconsultation
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-1',
      branchId: 'b-1',
      isActive: true,
      type: 'CONSULTA',
      observations: '',
      authorizationStatus: 'AUTHORIZED',
    });
    res = await app.inject({ method: 'GET', url: '/tele/public?token=x' });
    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it('handles FILE type signals and file messages in listing', async () => {
    const app = await buildApp();

    // chat-file missing fileName or fileDataUrl → 400
    let res = await app.inject({
      method: 'POST',
      url: '/tele/public/signal',
      payload: { token: 'x', type: 'chat-file', payload: { fileName: '', fileDataUrl: '' } },
    });
    expect(res.statusCode).toBe(400);

    // chat-file oversized fileDataUrl → 400 (requires custom bodyLimit)
    // NOTE: skip this because Fastify default bodyLimit (1MB) is hit before the app check

    // chat-file success (valid fileName and fileDataUrl, fileSizeBytes = NaN → null)
    res = await app.inject({
      method: 'POST',
      url: '/tele/public/signal',
      payload: { token: 'x', type: 'chat-file', payload: { fileName: 'a.pdf', fileDataUrl: 'data:application/pdf;base64,abc', fileSizeBytes: NaN } },
    });
    expect(res.statusCode).toBe(200);

    // GET /public/messages returns items with FILE kind
    mockedPrisma.teleconsultationMessage.findMany.mockResolvedValueOnce([{
      id: 'tm-2',
      fromRole: 'DOCTOR',
      messageType: 'FILE',
      text: null,
      fileName: 'doc.pdf',
      fileMimeType: 'application/pdf',
      fileSizeBytes: 1024,
      fileDataUrl: 'data:application/pdf;base64,abc',
      createdAt: new Date().toISOString(),
    }]);
    res = await app.inject({ method: 'GET', url: '/tele/public/messages?token=x' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].kind).toBe('file');

    // text too long → 400
    res = await app.inject({
      method: 'POST',
      url: '/tele/public/signal',
      payload: { token: 'x', type: 'chat-message', payload: { text: 'x'.repeat(1001) } },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('covers file-too-large check in POST /public/signal', async () => {
    // Build app with a larger bodyLimit so the 3MB+ payload is not rejected by Fastify before the route
    const bigApp = Fastify({ bodyLimit: 4_000_000 });
    bigApp.decorateRequest('user', null);
    bigApp.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
      this.user = { id: 'u-1' };
    });
    bigApp.decorate('jwt', {
      sign: vi.fn(() => 'signed-token'),
      verify: vi.fn(() => ({
        scope: 'teleconsultation_link',
        role: 'PATIENT',
        appointmentId: 'a-1',
        branchId: 'b-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
      })),
    } as any);
    await bigApp.register(teleconsultationLinksRoutes, { prefix: '/tele' });

    const res = await bigApp.inject({
      method: 'POST',
      url: '/tele/public/signal',
      payload: {
        token: 'x',
        type: 'chat-file',
        payload: { fileName: 'big.pdf', fileDataUrl: 'data:application/pdf;base64,' + 'a'.repeat(3_000_001) },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('excede');

    await bigApp.close();
  });

  it('covers verifyPublicToken branches for invalid role and missing appointment', async () => {
    // invalid role in token payload -> 401
    const invalidRoleApp = Fastify();
    invalidRoleApp.decorateRequest('user', null);
    invalidRoleApp.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
      this.user = { id: 'u-1' };
    });
    invalidRoleApp.decorate('jwt', {
      sign: vi.fn(() => 'signed-token'),
      verify: vi.fn(() => ({
        scope: 'teleconsultation_link',
        role: 'INVALID_ROLE',
        appointmentId: 'a-1',
        branchId: 'b-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
      })),
    } as any);
    await invalidRoleApp.register(teleconsultationLinksRoutes, { prefix: '/tele' });

    let res = await invalidRoleApp.inject({ method: 'GET', url: '/tele/public?token=x' });
    expect(res.statusCode).toBe(401);
    await invalidRoleApp.close();

    // appointment not found for a valid token payload -> 404
    const missingAppointmentApp = Fastify();
    missingAppointmentApp.decorateRequest('user', null);
    missingAppointmentApp.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
      this.user = { id: 'u-1' };
    });
    missingAppointmentApp.decorate('jwt', {
      sign: vi.fn(() => 'signed-token'),
      verify: vi.fn(() => ({
        scope: 'teleconsultation_link',
        role: 'PATIENT',
        appointmentId: 'a-missing',
        branchId: 'b-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
      })),
    } as any);
    await missingAppointmentApp.register(teleconsultationLinksRoutes, { prefix: '/tele' });

    mockedPrisma.appointment.findFirst.mockResolvedValueOnce(null);
    res = await missingAppointmentApp.inject({ method: 'GET', url: '/tele/public?token=x' });
    expect(res.statusCode).toBe(404);
    await missingAppointmentApp.close();
  });
});
