import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import preSchedulingRoutes from '../../src/modules/care/routes/pre-scheduling';
import prisma from '../../src/modules/care/lib/prisma';
import { getAnexosStorage } from '../../src/lib/storage';
import { createMessagingService } from '../../src/modules/care/lib/messaging';

const mockedCreateMessagingService = createMessagingService as unknown as Mock;

vi.mock('../../src/lib/storage', () => ({
  getAnexosStorage: vi.fn(() => ({
    save: vi.fn(),
    exists: vi.fn(),
    createReadStream: vi.fn(),
  })),
}));

vi.mock('../../src/modules/care/lib/messaging', () => ({
  createMessagingService: vi.fn().mockImplementation(() => ({
    sendTextMessage: vi.fn().mockResolvedValue({ status: 'success', messageId: 'm-1' }),
  })),
  MetaMessagingService: vi.fn().mockImplementation(() => ({
    sendTextMessage: vi.fn().mockResolvedValue({ status: 'success', messageId: 'm-1' }),
  })),
}));

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    appointment: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    patient: { findFirst: vi.fn(), findUnique: vi.fn() },
    preSchedulingFlow: { findMany: vi.fn(), upsert: vi.fn(), update: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    preSchedulingDocument: { create: vi.fn() },
    preSchedulingAnamnesisAnswer: { deleteMany: vi.fn(), create: vi.fn() },
    preSchedulingAnamnesisResponse: { upsert: vi.fn(), findUnique: vi.fn() },
    procedure: { findMany: vi.fn() },
    branch: { findUnique: vi.fn(), findMany: vi.fn() },
    branchSettings: { findUnique: vi.fn() },
    whatsAppConfig: { findUnique: vi.fn(), findMany: vi.fn() },
    whatsAppMessageLog: { create: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
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
  await app.register(preSchedulingRoutes, { prefix: '/pre-scheduling' });
  return app;
}

describe('care pre-scheduling routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedCreateMessagingService.mockImplementation(() => ({
      sendTextMessage: vi.fn().mockResolvedValue({ status: 'success', messageId: 'm-1' }),
    }));
    process.env.PUBLIC_APP_URL = 'https://app.example.com';
    (getAnexosStorage as any).mockReturnValue({
      save: vi.fn(),
      exists: vi.fn().mockResolvedValue(true),
      createReadStream: vi.fn(),
    });

    mockedPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', sector: { branch: { id: 'b-1' } } });
    mockedPrisma.appointment.findMany.mockResolvedValue([
      {
        id: 'a-1',
        branchId: 'b-1',
        isActive: true,
        status: 'CONFIRMED',
        patientName: 'Maria',
        patientCpf: '12345678900',
        patientId: 'p-1',
        doctorName: 'Dr',
        specialty: 'Clinica',
        convenio: 'X',
        date: '2026-04-13',
        time: '10:00',
        authorizationStatus: 'PENDING',
      },
    ]);
    mockedPrisma.preSchedulingFlow.findMany.mockResolvedValue([]);
    mockedPrisma.procedure.findMany.mockResolvedValue([]);
    mockedPrisma.branch.findUnique.mockResolvedValue({ companyId: null });
    mockedPrisma.branch.findMany.mockResolvedValue([{ id: 'b-1' }]);

    mockedPrisma.appointment.findFirst.mockResolvedValue({
      id: 'a-1',
      branchId: 'b-1',
      isActive: true,
      status: 'CONFIRMED',
      patientName: 'Maria',
      patientCpf: '12345678900',
      patientId: 'p-1',
      authorizationStatus: 'PENDING',
      observations: '[MODALIDADE: TELECONSULTA]',
      type: 'CONSULTA',
      specialty: 'Clinica',
    });
    mockedPrisma.patient.findFirst.mockResolvedValue({ id: 'p-1', name: 'Maria', cpf: '12345678900', cellphone: '1199999' });
    mockedPrisma.patient.findUnique.mockResolvedValue(null);
    mockedPrisma.branchSettings.findUnique.mockResolvedValue(null);
    mockedPrisma.preSchedulingFlow.upsert.mockResolvedValue({ id: 'f-1', status: 'PENDING', guideNumber: null, preAuthorizedAt: null });
    mockedPrisma.preSchedulingFlow.update.mockResolvedValue({ id: 'f-1', status: 'PRE_AUTHORIZED' });
    mockedPrisma.preSchedulingFlow.findUnique.mockResolvedValue({ id: 'f-1', status: 'PENDING', documents: [], anamnesisResponse: null });
    mockedPrisma.appointment.update.mockResolvedValue({ id: 'a-1' });
    mockedPrisma.preSchedulingDocument.create.mockResolvedValue({
      id: 'doc-1',
      documentType: 'RG',
      fileName: 'rg.pdf',
      uploadedAt: new Date('2026-04-13T10:00:00Z'),
    });
    mockedPrisma.preSchedulingAnamnesisResponse.upsert.mockResolvedValue({ id: 'ar-1' });
    mockedPrisma.preSchedulingAnamnesisResponse.findUnique.mockResolvedValue({ id: 'ar-1', answers: [] });
    mockedPrisma.preSchedulingAnamnesisAnswer.deleteMany.mockResolvedValue({ count: 0 });
    mockedPrisma.preSchedulingAnamnesisAnswer.create.mockResolvedValue({ id: 'aa-1' });
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValue(null);
    mockedPrisma.whatsAppConfig.findMany.mockResolvedValue([]);
    mockedPrisma.whatsAppMessageLog.create.mockResolvedValue({ id: 'log-1' });
    mockedPrisma.whatsAppMessageLog.update.mockResolvedValue({ id: 'log-1' });
    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb(mockedPrisma));
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValue({
      id: 'f-1',
      branchId: 'b-1',
      status: 'PENDING',
      patientCpf: '12345678900',
      patientVerifiedAt: null,
      patientAccessExpiresAt: null,
      appointment: {
        id: 'a-1',
        branchId: 'b-1',
        isActive: true,
        observations: '[MODALIDADE: TELECONSULTA]',
        patientName: 'Maria',
        doctorName: 'Dr',
        specialty: 'Clinica',
        date: '2026-04-13',
        time: '10:00',
      },
      documents: [],
      anamnesisResponse: null,
    });
  });

  it('handles auth and list endpoint', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/pre-scheduling' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    const app = await buildApp();
    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/pre-scheduling' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/pre-scheduling?search=maria&includeResolved=true' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBe(1);
    await app.close();
  });

  it('pre-authorizes appointment with guards', async () => {
    const app = await buildApp();

    mockedPrisma.appointment.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/pre-authorize', payload: {} });
    expect(res.statusCode).toBe(404);

    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({ id: 'a-1', status: 'PENDING', branchId: 'b-1', isActive: true });
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/pre-authorize', payload: {} });
    expect(res.statusCode).toBe(400);

    mockedPrisma.preSchedulingFlow.upsert.mockResolvedValueOnce({ id: 'f-1', status: 'PENDING', preAuthorizedAt: new Date() });
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/pre-authorize', payload: {} });
    expect(res.statusCode).toBe(400);

    mockedPrisma.preSchedulingFlow.upsert.mockResolvedValueOnce({ id: 'f-1', status: 'PENDING', preAuthorizedAt: null, guideNumber: null });
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/pre-authorize', payload: { guideNumber: 'G-1', notes: 'ok' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toContain('Pré-autorização');
    await app.close();
  });

  it('handles public flow resolve and verify', async () => {
    const app = await buildApp();

    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'GET', url: '/pre-scheduling/public/token-x' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1',
      branchId: 'b-1',
      status: 'PENDING',
      patientCpf: '12345678900',
      patientVerifiedAt: null,
      patientAccessExpiresAt: new Date(Date.now() - 60000).toISOString(),
      appointment: { id: 'a-1', observations: '[MODALIDADE: TELECONSULTA]' },
      documents: [],
      anamnesisResponse: null,
    });
    res = await app.inject({ method: 'GET', url: '/pre-scheduling/public/token-x' });
    expect(res.statusCode).toBe(410);

    res = await app.inject({ method: 'POST', url: '/pre-scheduling/public/token-x/verify', payload: { recognizedCpf: '' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/pre-scheduling/public/token-x/verify', payload: { recognizedCpf: '000' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1',
      branchId: 'b-1',
      status: 'PENDING',
      patientCpf: '12345678900',
      patientVerifiedAt: null,
      patientAccessExpiresAt: null,
      appointment: { id: 'a-1', observations: '[MODALIDADE: TELECONSULTA]' },
    });
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/public/token-x/verify', payload: { recognizedCpf: '123.456.789-00', recognizedTrust: 0.9 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().verified).toBe(true);

    await app.close();
  });

  it('sends link and returns generated public url', async () => {
    const app = await buildApp();
    mockedPrisma.preSchedulingFlow.findUnique.mockResolvedValueOnce({
      id: 'f-1',
      status: 'PENDING',
      patientSubmittedAt: null,
      documents: [],
      anamnesisResponse: null,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/pre-scheduling/a-1/send-link',
      payload: { notes: 'teste' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().message).toContain('Link gerado');
    expect(String(res.json().publicUrl || '')).toContain('/pre-atendimento/documentos/');
    await app.close();
  });

  it('lists documents and handles document view not found in storage', async () => {
    const app = await buildApp();
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1',
      appointment: { id: 'a-1', type: 'CONSULTA', specialty: 'Clinica' },
      documents: [{ id: 'doc-1', documentType: 'RG', fileName: 'rg.pdf', mimeType: 'application/pdf', sizeBytes: 10, uploadedAt: new Date() }],
      anamnesisResponse: { submittedAt: null, answers: [] },
    });

    let res = await app.inject({ method: 'GET', url: '/pre-scheduling/a-1/documents' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBe(1);

    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1',
      documents: [{ id: 'doc-1', gcsObjectName: 'x', fileName: 'rg.pdf', mimeType: 'application/pdf' }],
    });
    const storage = getAnexosStorage() as any;
    storage.exists.mockResolvedValueOnce(false);

    res = await app.inject({ method: 'GET', url: '/pre-scheduling/a-1/documents/doc-1/view' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('reviews documents and manual finalize flow', async () => {
    const app = await buildApp();
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1',
      preAuthorizedAt: new Date(),
      documents: [{ id: 'doc-1' }],
      appointment: { observations: '[MODALIDADE: TELECONSULTA]', type: 'CONSULTA', specialty: 'Clinica' },
      anamnesisResponse: null,
    });
    mockedPrisma.preSchedulingFlow.update.mockResolvedValueOnce({ id: 'f-1', status: 'COMPLETED' });

    let res = await app.inject({
      method: 'POST',
      url: '/pre-scheduling/a-1/review-documents',
      payload: { action: 'APPROVE' },
    });
    expect(res.statusCode).toBe(200);

    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1',
      preAuthorizedAt: new Date(),
      status: 'PRE_AUTHORIZED',
      completedAt: null,
      appointment: { observations: '[MODALIDADE: TELECONSULTA]' },
    });
    mockedPrisma.preSchedulingFlow.update.mockResolvedValueOnce({ id: 'f-1', status: 'COMPLETED', completedAt: new Date() });
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/manual-finalize' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('filters list by status, resolvedOnly, includeResolved, and dates', async () => {
    const app = await buildApp();

    // resolved item (preAuthorizedAt + COMPLETED + non-teleconsult)
    const resolvedAppt = {
      id: 'a-resolved', branchId: 'b-1', isActive: true, status: 'CONFIRMED',
      patientName: 'Maria', patientCpf: '12345678900', patientId: null,
      doctorName: 'Dr', specialty: 'Clinica', convenio: 'X', date: '2026-04-13', time: '10:00',
      observations: 'sem teleconsulta', authorizationStatus: 'AUTHORIZED',
    };
    const resolvedFlow = {
      id: 'f-resolved', appointmentId: 'a-resolved', status: 'COMPLETED',
      preAuthorizedAt: new Date(), completedAt: null, documents: [], anamnesisResponse: null,
    };

    // Default: isResolved=true items excluded
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([resolvedAppt]);
    mockedPrisma.preSchedulingFlow.findMany.mockResolvedValueOnce([resolvedFlow]);
    let res = await app.inject({ method: 'GET', url: '/pre-scheduling' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBe(0);

    // resolvedOnly=true
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([resolvedAppt]);
    mockedPrisma.preSchedulingFlow.findMany.mockResolvedValueOnce([resolvedFlow]);
    res = await app.inject({ method: 'GET', url: '/pre-scheduling?resolvedOnly=true' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBe(1);

    // status filter (PENDING item filtered out by PRE_AUTHORIZED filter)
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([
      { id: 'a-1', branchId: 'b-1', isActive: true, status: 'CONFIRMED', patientName: 'Maria',
        patientCpf: '12345678900', patientId: null, doctorName: 'Dr', specialty: null,
        convenio: null, date: '2026-04-13', time: '10:00', observations: null, authorizationStatus: 'PENDING' },
    ]);
    mockedPrisma.preSchedulingFlow.findMany.mockResolvedValueOnce([
      { id: 'f-1', appointmentId: 'a-1', status: 'PENDING', preAuthorizedAt: null, documents: [], anamnesisResponse: null },
    ]);
    res = await app.inject({ method: 'GET', url: '/pre-scheduling?status=PRE_AUTHORIZED' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBe(0);

    // dateFrom + dateTo builds where.date filter
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([]);
    mockedPrisma.preSchedulingFlow.findMany.mockResolvedValueOnce([]);
    res = await app.inject({ method: 'GET', url: '/pre-scheduling?dateFrom=2026-01-01&dateTo=2026-12-31' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('pre-authorizes flow with status DOCUMENTS_RECEIVED transitioning to COMPLETED', async () => {
    const app = await buildApp();

    mockedPrisma.preSchedulingFlow.upsert.mockResolvedValueOnce({
      id: 'f-1', status: 'DOCUMENTS_RECEIVED', preAuthorizedAt: null, guideNumber: 'G-existing',
    });
    mockedPrisma.preSchedulingFlow.update.mockResolvedValueOnce({ id: 'f-1', status: 'COMPLETED' });

    const res = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/pre-authorize', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.preSchedulingFlow.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PRE_AUTHORIZED' }) }),
    );
    await app.close();
  });

  it('send-link rejects when flow already has data or bad status', async () => {
    const app = await buildApp();

    // hasDocuments
    mockedPrisma.preSchedulingFlow.findUnique.mockResolvedValueOnce({
      id: 'f-1', status: 'WAITING_PATIENT_DOCUMENTS', patientSubmittedAt: null,
      documents: [{ id: 'd-1' }], anamnesisResponse: null,
    });
    let res = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/send-link', payload: {} });
    expect(res.statusCode).toBe(400);

    // hasAnamnesisResponse
    mockedPrisma.preSchedulingFlow.findUnique.mockResolvedValueOnce({
      id: 'f-1', status: 'WAITING_PATIENT_DOCUMENTS', patientSubmittedAt: null,
      documents: [], anamnesisResponse: { id: 'ar-1' },
    });
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/send-link', payload: {} });
    expect(res.statusCode).toBe(400);

    // status COMPLETED
    mockedPrisma.preSchedulingFlow.findUnique.mockResolvedValueOnce({
      id: 'f-1', status: 'COMPLETED', patientSubmittedAt: null, documents: [], anamnesisResponse: null,
    });
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/send-link', payload: {} });
    expect(res.statusCode).toBe(400);

    // alreadySubmitted
    mockedPrisma.preSchedulingFlow.findUnique.mockResolvedValueOnce({
      id: 'f-1', status: 'PENDING', patientSubmittedAt: new Date(), documents: [], anamnesisResponse: null,
    });
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/send-link', payload: {} });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('send-link uses active whatsapp config and covers anamnesis message branch', async () => {
    const app = await buildApp();

    // With active whatsapp config
    mockedPrisma.patient.findFirst.mockResolvedValueOnce({ id: 'p-1', name: 'Maria', cpf: '12345678900', cellphone: '1199999', phone: null });
    mockedPrisma.preSchedulingFlow.upsert.mockResolvedValueOnce({ id: 'f-1', status: 'PENDING', preAuthorizedAt: null, patientPhone: '1199999', patientName: 'Maria' });
    mockedPrisma.preSchedulingFlow.findUnique.mockResolvedValueOnce({
      id: 'f-1', status: 'PENDING', patientSubmittedAt: null, documents: [], anamnesisResponse: null,
    });
    const activeConfig = {
      branchId: 'b-1', isActive: true, accountSid: 'key', authToken: 'app', fromNumber: 'src',
    };
    mockedPrisma.whatsAppConfig.findUnique
      .mockResolvedValueOnce(activeConfig)
      .mockResolvedValueOnce(activeConfig);
    mockedPrisma.preSchedulingFlow.update.mockResolvedValueOnce({ id: 'f-1', status: 'WAITING_PATIENT_DOCUMENTS' });

    const res = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/send-link', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().whatsapp.provider).toBe('meta');

    // With anamnesis template
    mockedPrisma.preSchedulingFlow.findUnique.mockResolvedValueOnce({
      id: 'f-1', status: 'PENDING', patientSubmittedAt: null, documents: [], anamnesisResponse: null,
    });
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce(null);
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([
      { id: 'proc-1', name: 'Clinica', anamnesisTemplates: [{ id: 't-1', name: 'T', description: null, questions: [] }] },
    ]);

    const res2 = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/send-link', payload: {} });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().hasAnamnesis).toBe(true);

    await app.close();
  });

  it('handles view-document: flow not found and document missing from DB', async () => {
    const app = await buildApp();

    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce(null);
    const res1 = await app.inject({ method: 'GET', url: '/pre-scheduling/a-1/documents/doc-1/view' });
    expect(res1.statusCode).toBe(404);

    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({ id: 'f-1', documents: [] });
    const res2 = await app.inject({ method: 'GET', url: '/pre-scheduling/a-1/documents/doc-1/view' });
    expect(res2.statusCode).toBe(404);

    await app.close();
  });

  it('handles documents list when flow not found', async () => {
    const app = await buildApp();

    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce(null);
    const res = await app.inject({ method: 'GET', url: '/pre-scheduling/a-1/documents' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
    expect(res.json().anamnesis).toBeNull();

    await app.close();
  });

  it('review-documents covers all action branches and guards', async () => {
    const app = await buildApp();

    // flow not found
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/review-documents', payload: { action: 'APPROVE' } });
    expect(res.statusCode).toBe(404);

    // no docs + no anamnesis
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1', preAuthorizedAt: null, documents: [],
      appointment: { observations: '', type: 'CONSULTA', specialty: 'Clinica' }, anamnesisResponse: null,
    });
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/review-documents', payload: { action: 'APPROVE' } });
    expect(res.statusCode).toBe(400);

    // APPROVE without preAuthorization → DOCUMENTS_RECEIVED
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1', preAuthorizedAt: null, documents: [{ id: 'd-1' }],
      appointment: { observations: '', type: 'CONSULTA', specialty: null }, anamnesisResponse: null,
    });
    mockedPrisma.preSchedulingFlow.update.mockResolvedValueOnce({ id: 'f-1', status: 'DOCUMENTS_RECEIVED' });
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/review-documents', payload: { action: 'APPROVE' } });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.preSchedulingFlow.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DOCUMENTS_RECEIVED' }) }),
    );

    // APPROVE with preAuthorization keeps the flow waiting for manual/final completion
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1', preAuthorizedAt: new Date(), documents: [{ id: 'd-1' }],
      appointment: { observations: 'no-marker', type: 'CONSULTA', specialty: null }, anamnesisResponse: null,
    });
    mockedPrisma.preSchedulingFlow.update.mockResolvedValueOnce({ id: 'f-1', status: 'DOCUMENTS_RECEIVED', completedAt: null });
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/review-documents', payload: { action: 'APPROVE' } });
    expect(res.statusCode).toBe(200);
    const lastUpdateCall = mockedPrisma.preSchedulingFlow.update.mock.calls.at(-1)?.[0];
    expect(lastUpdateCall?.data?.completedAt).toBeNull();

    // REQUEST_RESUBMISSION
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1', preAuthorizedAt: null, documents: [{ id: 'd-1' }],
      appointment: { observations: '', type: 'CONSULTA', specialty: null }, anamnesisResponse: null,
    });
    mockedPrisma.preSchedulingFlow.update.mockResolvedValueOnce({ id: 'f-1', status: 'WAITING_PATIENT_DOCUMENTS' });
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/review-documents', payload: { action: 'REQUEST_RESUBMISSION' } });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.preSchedulingFlow.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'WAITING_PATIENT_DOCUMENTS' }) }),
    );

    await app.close();
  });

  it('manual-finalize covers all guard branches and idempotency', async () => {
    const app = await buildApp();

    // flow not found
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/manual-finalize' });
    expect(res.statusCode).toBe(404);

    // not teleconsult
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1', status: 'PRE_AUTHORIZED', preAuthorizedAt: new Date(), completedAt: null,
      appointment: { observations: '' },
    });
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/manual-finalize' });
    expect(res.statusCode).toBe(400);

    // no pre-authorization
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1', status: 'PRE_AUTHORIZED', preAuthorizedAt: null, completedAt: null,
      appointment: { observations: '[MODALIDADE: TELECONSULTA]' },
    });
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/manual-finalize' });
    expect(res.statusCode).toBe(400);

    // CANCELED status
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1', status: 'CANCELED', preAuthorizedAt: new Date(), completedAt: null,
      appointment: { observations: '[MODALIDADE: TELECONSULTA]' },
    });
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/manual-finalize' });
    expect(res.statusCode).toBe(400);

    // already completed → idempotent
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1', status: 'COMPLETED', preAuthorizedAt: new Date(), completedAt: new Date('2026-04-13'),
      appointment: { observations: '[MODALIDADE: TELECONSULTA]' },
    });
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/a-1/manual-finalize' });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toContain('já finalizado');

    await app.close();
  });

  it('public GET covers interaction-completed not-expired and verified flag', async () => {
    const app = await buildApp();

    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1', branchId: 'b-1', status: 'DOCUMENTS_RECEIVED',
      patientVerifiedAt: new Date(),
      patientAccessExpiresAt: new Date(Date.now() - 60000).toISOString(),
      patientSubmittedAt: new Date(),
      appointment: { id: 'a-1', observations: '', specialty: null, doctorName: null, date: null, time: null, type: 'CONSULTA' },
      documents: [],
      anamnesisResponse: null,
    });

    const res = await app.inject({ method: 'GET', url: '/pre-scheduling/public/token-x' });
    expect(res.statusCode).toBe(200);
    expect(res.json().verified).toBe(true);
    expect(res.json().interactionCompleted).toBe(true);

    await app.close();
  });

  it('verify: already verified, CPF mismatch, non-PENDING status unchanged', async () => {
    const app = await buildApp();

    // already verified
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1', status: 'WAITING_PATIENT_DOCUMENTS', patientCpf: null,
      patientVerifiedAt: new Date(), patientAccessExpiresAt: null,
      appointment: { id: 'a-1', observations: '' },
    });
    let res = await app.inject({ method: 'POST', url: '/pre-scheduling/public/token-x/verify', payload: { recognizedCpf: '123.456.789-00' } });
    expect(res.statusCode).toBe(400);

    // CPF mismatch
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1', status: 'PENDING', patientCpf: '99988877766',
      patientVerifiedAt: null, patientAccessExpiresAt: null,
      appointment: { id: 'a-1', observations: '' },
    });
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/public/token-x/verify', payload: { recognizedCpf: '123.456.789-00' } });
    expect(res.statusCode).toBe(400);

    // Non-PENDING status: verify success but status unchanged
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1', status: 'WAITING_PATIENT_DOCUMENTS', patientCpf: null,
      patientVerifiedAt: null, patientAccessExpiresAt: null,
      appointment: { id: 'a-1', observations: '' },
    });
    mockedPrisma.preSchedulingFlow.update.mockResolvedValueOnce({
      patientVerifiedTrust: 0.9, patientVerifiedName: null,
      patientAccessExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/public/token-x/verify', payload: { recognizedCpf: '123.456.789-00' } });
    expect(res.statusCode).toBe(200);
    const updateCall = mockedPrisma.preSchedulingFlow.update.mock.calls.at(-1)?.[0];
    expect(updateCall?.data?.status).toBe('WAITING_PATIENT_DOCUMENTS');

    await app.close();
  });

  it('upload covers interaction-completed, no-CPF, not-verified, CPF-mismatch, empty-buffer', async () => {
    const app = await buildApp();

    // interaction already completed
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1', status: 'DOCUMENTS_RECEIVED', patientVerifiedAt: new Date(),
      patientVerifiedCpf: '12345678900', patientSubmittedAt: new Date(),
    });
    let res = await app.inject({
      method: 'POST', url: '/pre-scheduling/public/token-x/upload',
      payload: { documentType: 'RG', fileName: 'rg.pdf', fileBase64: Buffer.from('x').toString('base64') },
    });
    expect(res.statusCode).toBe(400);

    // no CPF at all
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1', status: 'PENDING', patientVerifiedAt: null, patientVerifiedCpf: null, patientSubmittedAt: null,
    });
    res = await app.inject({
      method: 'POST', url: '/pre-scheduling/public/token-x/upload',
      payload: { cpf: '', documentType: 'RG', fileName: 'rg.pdf', fileBase64: Buffer.from('x').toString('base64') },
    });
    expect(res.statusCode).toBe(400);

    // not verified
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1', status: 'PENDING', patientVerifiedAt: null, patientVerifiedCpf: null, patientSubmittedAt: null,
    });
    res = await app.inject({
      method: 'POST', url: '/pre-scheduling/public/token-x/upload',
      payload: { cpf: '12345678900', documentType: 'RG', fileName: 'rg.pdf', fileBase64: Buffer.from('x').toString('base64') },
    });
    expect(res.statusCode).toBe(400);

    // CPF mismatch
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1', status: 'PENDING', patientVerifiedAt: new Date(), patientVerifiedCpf: '99988877766', patientSubmittedAt: null,
    });
    res = await app.inject({
      method: 'POST', url: '/pre-scheduling/public/token-x/upload',
      payload: { cpf: '12345678900', documentType: 'RG', fileName: 'rg.pdf', fileBase64: Buffer.from('x').toString('base64') },
    });
    expect(res.statusCode).toBe(400);

    // empty buffer
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1', branchId: 'b-1', status: 'PENDING', patientVerifiedAt: new Date(),
      patientVerifiedCpf: '12345678900', patientSubmittedAt: null,
    });
    res = await app.inject({
      method: 'POST', url: '/pre-scheduling/public/token-x/upload',
      payload: { cpf: '12345678900', documentType: 'RG', fileName: 'rg.pdf', fileBase64: '' },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('anamnesis covers not-verified, completed, already-answered, required-type validations', async () => {
    const app = await buildApp();

    const baseFlow = {
      id: 'f-1', branchId: 'b-1', status: 'WAITING_PATIENT_DOCUMENTS',
      patientVerifiedAt: null, patientSubmittedAt: null, anamnesisResponse: null,
      appointment: { type: 'CONSULTA', specialty: 'Clinica' },
    };

    // not verified
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({ ...baseFlow });
    let res = await app.inject({ method: 'POST', url: '/pre-scheduling/public/token-x/anamnesis', payload: { answers: [] } });
    expect(res.statusCode).toBe(400);

    // already completed
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({ ...baseFlow, patientVerifiedAt: new Date(), status: 'DOCUMENTS_RECEIVED' });
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/public/token-x/anamnesis', payload: { answers: [] } });
    expect(res.statusCode).toBe(400);

    // EXAME type → no template → 404
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({ ...baseFlow, patientVerifiedAt: new Date(), appointment: { type: 'EXAME', specialty: 'X' } });
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/public/token-x/anamnesis', payload: { answers: [] } });
    expect(res.statusCode).toBe(404);

    // already answered
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({ ...baseFlow, patientVerifiedAt: new Date(), anamnesisResponse: { id: 'ar-existing' } });
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([
      { id: 'proc-1', name: 'Clinica', anamnesisTemplates: [{ id: 't-1', name: 'T', description: null, questions: [] }] },
    ]);
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/public/token-x/anamnesis', payload: { answers: [] } });
    expect(res.statusCode).toBe(400);

    // required BOOLEAN missing
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({ ...baseFlow, patientVerifiedAt: new Date() });
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([
      { id: 'proc-1', name: 'Clinica', anamnesisTemplates: [{ id: 't-1', name: 'T', description: null,
        questions: [{ id: 'q-bool', label: 'Alergias?', responseType: 'BOOLEAN', isRequired: true, orderIndex: 1, options: [] }] }] },
    ]);
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/public/token-x/anamnesis', payload: { answers: [] } });
    expect(res.statusCode).toBe(400);

    // required NUMBER missing
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({ ...baseFlow, patientVerifiedAt: new Date() });
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([
      { id: 'proc-1', name: 'Clinica', anamnesisTemplates: [{ id: 't-1', name: 'T', description: null,
        questions: [{ id: 'q-num', label: 'Peso?', responseType: 'NUMBER', isRequired: true, orderIndex: 1, options: [] }] }] },
    ]);
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/public/token-x/anamnesis', payload: { answers: [] } });
    expect(res.statusCode).toBe(400);

    // required SINGLE_CHOICE missing values
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({ ...baseFlow, patientVerifiedAt: new Date() });
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([
      { id: 'proc-1', name: 'Clinica', anamnesisTemplates: [{ id: 't-1', name: 'T', description: null,
        questions: [{ id: 'q-sc', label: 'Escolha', responseType: 'SINGLE_CHOICE', isRequired: true, orderIndex: 1, options: [] }] }] },
    ]);
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/public/token-x/anamnesis', payload: { answers: [] } });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('finalize covers not-verified, already-completed, missing-anamnesis, no-docs-no-anamnesis', async () => {
    const app = await buildApp();

    const baseFlow = {
      id: 'f-1', branchId: 'b-1', status: 'WAITING_PATIENT_DOCUMENTS',
      patientVerifiedAt: null, patientSubmittedAt: null,
      documents: [], anamnesisResponse: null,
      appointment: { type: 'CONSULTA', specialty: 'Clinica' },
    };

    // not verified
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({ ...baseFlow });
    let res = await app.inject({ method: 'POST', url: '/pre-scheduling/public/token-x/finalize' });
    expect(res.statusCode).toBe(400);

    // already completed
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({ ...baseFlow, patientVerifiedAt: new Date(), status: 'DOCUMENTS_RECEIVED' });
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/public/token-x/finalize' });
    expect(res.statusCode).toBe(400);

    // anamnesisTemplate exists but no response
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({ ...baseFlow, patientVerifiedAt: new Date(), documents: [{ id: 'd-1' }] });
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([
      { id: 'proc-1', name: 'Clinica', anamnesisTemplates: [{ id: 't-1', name: 'T', description: null, questions: [] }] },
    ]);
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/public/token-x/finalize' });
    expect(res.statusCode).toBe(400);

    // no docs AND no anamnesis
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({ ...baseFlow, patientVerifiedAt: new Date(), appointment: { type: 'EXAME', specialty: 'X' } });
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([]);
    res = await app.inject({ method: 'POST', url: '/pre-scheduling/public/token-x/finalize' });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('handles public upload, anamnesis and finalize', async () => {
    const app = await buildApp();
    const token = 'token-x';

    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1',
      branchId: 'b-1',
      publicToken: token,
      status: 'WAITING_PATIENT_DOCUMENTS',
      patientVerifiedAt: new Date(),
      patientVerifiedCpf: '12345678900',
      patientSubmittedAt: null,
    });

    let res = await app.inject({
      method: 'POST',
      url: `/pre-scheduling/public/${token}/upload`,
      payload: {
        cpf: '123.456.789-00',
        documentType: 'RG',
        fileName: 'rg.pdf',
        fileBase64: Buffer.from('abc').toString('base64'),
        mimeType: 'application/pdf',
      },
    });
    expect(res.statusCode).toBe(200);

    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1',
      branchId: 'b-1',
      publicToken: token,
      status: 'WAITING_PATIENT_DOCUMENTS',
      patientVerifiedAt: new Date(),
      patientSubmittedAt: null,
      anamnesisResponse: null,
      appointment: { type: 'CONSULTA', specialty: 'Clinica' },
    });
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([
      {
        id: 'proc-1',
        name: 'Clinica',
        anamnesisTemplates: [{
          id: 't-1',
          name: 'Template',
          description: null,
          questions: [{ id: 'q-1', label: 'Queixa', responseType: 'TEXT', isRequired: true, orderIndex: 1, options: [] }],
        }],
      },
    ]);

    res = await app.inject({
      method: 'POST',
      url: `/pre-scheduling/public/${token}/anamnesis`,
      payload: { answers: [{ questionId: 'q-1', answerText: 'dor' }] },
    });
    expect(res.statusCode).toBe(200);

    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValueOnce({
      id: 'f-1',
      branchId: 'b-1',
      publicToken: token,
      status: 'WAITING_PATIENT_DOCUMENTS',
      patientVerifiedAt: new Date(),
      patientSubmittedAt: null,
      documents: [{ id: 'doc-1' }],
      appointment: { type: 'CONSULTA', specialty: 'Clinica' },
      anamnesisResponse: { id: 'ar-1' },
    });
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([
      { id: 'proc-1', name: 'Clinica', anamnesisTemplates: [{ id: 't-1', name: 'Template', description: null, questions: [] }] },
    ]);
    mockedPrisma.preSchedulingFlow.update.mockResolvedValueOnce({ id: 'f-1', status: 'DOCUMENTS_RECEIVED', patientSubmittedAt: new Date() });

    res = await app.inject({ method: 'POST', url: `/pre-scheduling/public/${token}/finalize`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('DOCUMENTS_RECEIVED');
    await app.close();
  });
});
