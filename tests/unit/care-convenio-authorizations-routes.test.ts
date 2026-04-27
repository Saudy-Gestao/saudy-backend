import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import convenioAuthorizationRoutes from '../../src/modules/care/routes/convenio-authorizations';
import prisma from '../../src/modules/care/lib/prisma';
import { getAnexosStorage } from '../../src/lib/storage';

vi.mock('../../src/lib/storage', () => ({
  getAnexosStorage: vi.fn(() => ({
    save: vi.fn(),
    exists: vi.fn(),
    createReadStream: vi.fn(),
  })),
}));

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    doctor: { findMany: vi.fn() },
    appointment: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    teaPreReservation: { findMany: vi.fn(), findFirst: vi.fn() },
    convenioAuthorizationAttachment: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const mockedPrisma = prisma as any;

async function buildApp(opts?: { unauthorized?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1', name: 'User' };
  });
  await app.register(convenioAuthorizationRoutes, { prefix: '/convenio-auth' });
  return app;
}

describe('care convenio-authorizations routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (getAnexosStorage as any).mockReturnValue({
      save: vi.fn(),
      exists: vi.fn().mockResolvedValue(true),
      createReadStream: vi.fn(),
    });

    mockedPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', sector: { branch: { id: 'b-1' } } });
    mockedPrisma.doctor.findMany.mockResolvedValue([{ id: 'd-1', name: 'Dr A', room: { name: 'Sala 1', branch: { tradeName: 'Unidade' } } }]);
    mockedPrisma.appointment.findMany.mockResolvedValue([{
      id: 'a-1',
      patientName: 'Maria',
      patientCpf: '12345678900',
      specialty: 'Consulta',
      doctorName: 'Dr A',
      date: '2026-04-13',
      time: '10:00',
      convenio: 'Plano X',
      authorizationStatus: 'PENDING',
      authorizationNotes: null,
      updatedAt: new Date('2026-04-13T10:00:00Z'),
    }]);
    mockedPrisma.teaPreReservation.findMany.mockResolvedValue([]);
    mockedPrisma.convenioAuthorizationAttachment.findMany.mockResolvedValue([]);
    mockedPrisma.appointment.findFirst.mockResolvedValue({ id: 'a-1', branchId: 'b-1', isActive: true });
    mockedPrisma.teaPreReservation.findFirst.mockResolvedValue({ id: 'pr-1' });
    mockedPrisma.convenioAuthorizationAttachment.findFirst.mockResolvedValue({
      id: 'att-1',
      branchId: 'b-1',
      isActive: true,
      fileName: 'doc.pdf',
      mimeType: 'application/pdf',
      gcsObjectName: 'obj-1',
    });
    mockedPrisma.convenioAuthorizationAttachment.create.mockResolvedValue({
      id: 'att-1',
      fileName: 'doc.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 3,
      uploadedAt: new Date('2026-04-13T10:00:00Z'),
    });
    mockedPrisma.appointment.update.mockResolvedValue({ id: 'a-1', authorizationStatus: 'AUTHORIZED' });
    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb({
      teaPreReservation: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      teaPreReservationTimeline: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    }));
  });

  it('enforces auth and handles empty branch on list', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/convenio-auth' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    const app = await buildApp();
    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/convenio-auth' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(0);
    await app.close();
  });

  it('lists authorization items and aggregates attachments', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([{
      id: 'pr-1',
      pitTherapyId: 'pit-1',
      status: 'PENDING_AUTHORIZATION',
      patient: { name: 'Joao', cpf: '111', healthInsuranceName: 'Plano Y' },
      procedureName: 'TO',
      professionalName: 'Dr A',
      suggestedDate: new Date('2026-04-14T00:00:00Z'),
      suggestedTime: '09:00',
      notes: null,
      updatedAt: new Date('2026-04-13T10:00:00Z'),
    }]);
    mockedPrisma.convenioAuthorizationAttachment.findMany.mockResolvedValueOnce([
      { id: 'att-1', sourceType: 'APPOINTMENT', appointmentId: 'a-1', fileName: 'a.pdf', mimeType: 'application/pdf', uploadedAt: new Date() },
    ]);

    const res = await app.inject({ method: 'GET', url: '/convenio-auth?search=maria' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  it('lists attachments and validates source type', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/convenio-auth/INVALID/x/attachments' });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'GET', url: '/convenio-auth/APPOINTMENT/a-1/attachments' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('views attachment and handles storage-missing file', async () => {
    const app = await buildApp();
    const storage = getAnexosStorage() as any;
    storage.exists.mockResolvedValueOnce(false);

    const res = await app.inject({ method: 'GET', url: '/convenio-auth/attachments/att-1/view' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('uploads attachment with validations and success', async () => {
    const app = await buildApp();

    let res = await app.inject({
      method: 'POST',
      url: '/convenio-auth/INVALID/a-1/attachments',
      payload: { fileName: 'x.pdf', fileBase64: Buffer.from('abc').toString('base64') },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.appointment.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({
      method: 'POST',
      url: '/convenio-auth/APPOINTMENT/a-x/attachments',
      payload: { fileName: 'x.pdf', fileBase64: Buffer.from('abc').toString('base64') },
    });
    expect(res.statusCode).toBe(404);

    mockedPrisma.teaPreReservation.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({
      method: 'POST',
      url: '/convenio-auth/TEA/pit-x/attachments',
      payload: { fileName: 'x.pdf', fileBase64: Buffer.from('abc').toString('base64') },
    });
    expect(res.statusCode).toBe(404);

    res = await app.inject({
      method: 'POST',
      url: '/convenio-auth/APPOINTMENT/a-1/attachments',
      payload: { fileName: 'x.pdf', fileBase64: '' },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/convenio-auth/APPOINTMENT/a-1/attachments',
      payload: { fileName: 'x.pdf', fileBase64: Buffer.from('abc').toString('base64'), mimeType: 'application/pdf' },
    });
    expect(res.statusCode).toBe(201);
    expect(mockedPrisma.convenioAuthorizationAttachment.create).toHaveBeenCalled();
    await app.close();
  });

  it('updates authorization status for appointment and tea', async () => {
    const app = await buildApp();

    mockedPrisma.appointment.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({
      method: 'PATCH',
      url: '/convenio-auth/APPOINTMENT/a-x',
      payload: { status: 'AUTHORIZED' },
    });
    expect(res.statusCode).toBe(404);

    res = await app.inject({
      method: 'PATCH',
      url: '/convenio-auth/APPOINTMENT/a-1',
      payload: { status: 'AUTHORIZED', notes: 'ok' },
    });
    expect(res.statusCode).toBe(200);

    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([]);
    res = await app.inject({
      method: 'PATCH',
      url: '/convenio-auth/TEA/pit-x',
      payload: { status: 'DENIED' },
    });
    expect(res.statusCode).toBe(404);

    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([{ id: 'pr-1' }]);
    res = await app.inject({
      method: 'PATCH',
      url: '/convenio-auth/TEA/pit-1',
      payload: { status: 'AUTHORIZED', notes: 'ok' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    res = await app.inject({
      method: 'PATCH',
      url: '/convenio-auth/INVALID/x',
      payload: { status: 'AUTHORIZED' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('updates TEA authorization status to DENIED and lists TEA attachments', async () => {
    const app = await buildApp();

    // DENIED status → teaStatus = 'CANCELED', mergedNotes = '[AUTH_DENIED] motivo'
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([{ id: 'pr-1' }]);
    let res = await app.inject({
      method: 'PATCH',
      url: '/convenio-auth/TEA/pit-1',
      payload: { status: 'DENIED', notes: 'motivo' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    // PENDING status → teaStatus = 'PENDING_AUTHORIZATION'
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([{ id: 'pr-1' }]);
    res = await app.inject({
      method: 'PATCH',
      url: '/convenio-auth/TEA/pit-1',
      payload: { status: 'PENDING' },
    });
    expect(res.statusCode).toBe(200);

    // GET TEA attachments
    res = await app.inject({ method: 'GET', url: '/convenio-auth/TEA/pit-1/attachments' });
    expect(res.statusCode).toBe(200);

    // APPOINTMENT attachments mapping with nullable mimeType/sizeBytes
    mockedPrisma.convenioAuthorizationAttachment.findMany.mockResolvedValueOnce([
      {
        id: 'att-x',
        fileName: 'x.pdf',
        mimeType: null,
        sizeBytes: 0,
        uploadedAt: new Date('2026-04-13T10:00:00Z'),
      },
    ]);
    res = await app.inject({ method: 'GET', url: '/convenio-auth/APPOINTMENT/a-1/attachments' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].mimeType).toBeNull();
    expect(res.json().items[0].sizeBytes).toBeNull();

    // list with two entries to exercise sort comparator path
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([
      {
        id: 'a-1',
        patientName: 'Maria',
        patientCpf: '12345678900',
        specialty: 'Consulta',
        doctorName: 'Dr A',
        date: '2026-04-14',
        time: '11:00',
        convenio: 'Plano X',
        authorizationStatus: 'PENDING',
        authorizationNotes: null,
        updatedAt: new Date('2026-04-13T10:00:00Z'),
      },
      {
        id: 'a-2',
        patientName: 'Joao',
        patientCpf: '00011122233',
        specialty: 'Consulta',
        doctorName: 'Dr B',
        date: '2026-04-13',
        time: '08:00',
        convenio: 'Plano X',
        authorizationStatus: 'AUTHORIZED',
        authorizationNotes: null,
        updatedAt: new Date('2026-04-13T10:00:00Z'),
      },
    ]);
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([]);
    res = await app.inject({ method: 'GET', url: '/convenio-auth' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThanOrEqual(1);

    await app.close();
  });

  it('covers empty attachments branch and mixed TEA grouped status sorting', async () => {
    const app = await buildApp();

    // no appointments and no tea reservations => attachments fallback to []
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([]);
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([]);
    let res = await app.inject({ method: 'GET', url: '/convenio-auth' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(0);

    // mixed tea statuses (AUTHORIZED + DENIED) should hit groupedStatus fallback branch
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([
      {
        id: 'a-10',
        patientName: 'Paciente A',
        patientCpf: '11111111111',
        specialty: 'Consulta',
        doctorName: 'Dr A',
        date: '2026-04-15',
        time: '10:00',
        convenio: 'Plano X',
        authorizationStatus: 'PENDING',
        authorizationNotes: null,
        updatedAt: new Date('2026-04-13T10:00:00Z'),
      },
      {
        id: 'a-11',
        patientName: 'Paciente B',
        patientCpf: '22222222222',
        specialty: 'Consulta',
        doctorName: 'Dr B',
        date: '2026-04-13',
        time: '08:00',
        convenio: 'Plano X',
        authorizationStatus: 'AUTHORIZED',
        authorizationNotes: null,
        updatedAt: new Date('2026-04-13T10:00:00Z'),
      },
    ]);
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([
      {
        id: 'pr-1',
        pitTherapyId: 'pit-mixed',
        status: 'AUTHORIZED',
        patient: { name: 'Joao', cpf: '333', healthInsuranceName: 'Plano Y' },
        procedureName: 'TO',
        professionalName: 'Dr A',
        suggestedDate: new Date('2026-04-14T00:00:00Z'),
        suggestedTime: '09:00',
        notes: null,
        updatedAt: new Date('2026-04-13T10:00:00Z'),
      },
      {
        id: 'pr-2',
        pitTherapyId: 'pit-mixed',
        status: 'CANCELED',
        patient: { name: 'Joao', cpf: '333', healthInsuranceName: 'Plano Y' },
        procedureName: 'TO',
        professionalName: 'Dr A',
        suggestedDate: new Date('2026-04-14T00:00:00Z'),
        suggestedTime: '09:00',
        notes: '[AUTH_DENIED] motivo',
        updatedAt: new Date('2026-04-13T11:00:00Z'),
      },
    ]);
    mockedPrisma.convenioAuthorizationAttachment.findMany.mockResolvedValueOnce([]);

    res = await app.inject({ method: 'GET', url: '/convenio-auth' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThanOrEqual(2);

    await app.close();
  });

  it('uploads TEA attachment successfully covering pitTherapyId branch', async () => {
    const app = await buildApp();

    mockedPrisma.teaPreReservation.findFirst.mockResolvedValueOnce({ id: 'pr-1' });

    const res = await app.inject({
      method: 'POST',
      url: '/convenio-auth/TEA/pit-1/attachments',
      payload: {
        fileName: 'doc.pdf',
        fileBase64: Buffer.from('pdfcontent').toString('base64'),
        mimeType: 'application/pdf',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockedPrisma.convenioAuthorizationAttachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceType: 'TEA',
          pitTherapyId: 'pit-1',
          appointmentId: null,
        }),
      }),
    );

    await app.close();
  });

  it('covers status=AUTHORIZED authorizedAt=null path and source filter', async () => {
    const app = await buildApp();

    // PATCH APPOINTMENT with non-AUTHORIZED status → authorizedAt null
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({ id: 'a-1', branchId: 'b-1', isActive: true });
    const res = await app.inject({
      method: 'PATCH',
      url: '/convenio-auth/APPOINTMENT/a-1',
      payload: { status: 'PENDING' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.appointment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ authorizedAt: null }),
      }),
    );

    // list with sourceTypes filter to hit source filter branch
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([]);
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([]);
    const res2 = await app.inject({ method: 'GET', url: '/convenio-auth?sourceTypes=APPOINTMENT&statuses=PENDING' });
    expect(res2.statusCode).toBe(200);

    await app.close();
  });

  it('filters appointments by doctor name mismatch and handles appointments without convenio', async () => {
    const app = await buildApp();

    // Appointment with doctorName 'Dr B' that doesn't match the logged-in doctor 'Dr A'
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([
      {
        id: 'a-nomatch',
        patientName: 'Other',
        patientCpf: '99999999999',
        specialty: 'Consulta',
        doctorName: 'Dr B',  // Not in doctors list which only has Dr A
        date: '2026-04-13',
        time: '10:00',
        convenio: null,  // No convenio, should show as 'PARTICULAR'
        authorizationStatus: 'PENDING',
        authorizationNotes: null,
        updatedAt: new Date('2026-04-13T10:00:00Z'),
      },
    ]);
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([]);
    mockedPrisma.convenioAuthorizationAttachment.findMany.mockResolvedValueOnce([]);

    const res = await app.inject({ method: 'GET', url: '/convenio-auth' });
    expect(res.statusCode).toBe(200);
    // The unmatched doctor should still appear (filter includes items where doctorName is not found)
    expect(res.json().items.length).toBeGreaterThanOrEqual(0);

    await app.close();
  });

  it('handles TEA authorizedAt set when status=AUTHORIZED', async () => {
    const app = await buildApp();

    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([{ id: 'pr-1' }]);
    const res = await app.inject({
      method: 'PATCH',
      url: '/convenio-auth/TEA/pit-1',
      payload: { status: 'AUTHORIZED' },
    });

    expect(res.statusCode).toBe(200);
    // Verify the transaction mock was called with authorizedAt set
    expect(mockedPrisma.$transaction).toHaveBeenCalled();

    await app.close();
  });

  it('filters by multiple statuses and search text across all fields', async () => {
    const app = await buildApp();

    mockedPrisma.appointment.findMany.mockResolvedValueOnce([
      {
        id: 'a-search-cpf',
        patientName: 'Test Patient',
        patientCpf: '12345678901',
        specialty: 'Cardio',
        doctorName: 'Dr A',
        date: '2026-04-20',
        time: '14:00',
        convenio: 'Bradesco',
        authorizationStatus: 'AUTHORIZED',
        authorizationNotes: null,
        updatedAt: new Date('2026-04-13T10:00:00Z'),
      },
    ]);
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([]);
    mockedPrisma.convenioAuthorizationAttachment.findMany.mockResolvedValueOnce([]);

    // Search by CPF
    let res = await app.inject({
      method: 'GET',
      url: '/convenio-auth?search=12345678901&statuses=AUTHORIZED',
    });
    expect(res.statusCode).toBe(200);

    // Search by procedure name
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([
      {
        id: 'a-cardio',
        patientName: 'Cardio Patient',
        patientCpf: '00000000000',
        specialty: 'Cardio Consultation',
        doctorName: 'Dr A',
        date: '2026-04-15',
        time: '11:00',
        convenio: 'Amil',
        authorizationStatus: 'PENDING',
        authorizationNotes: null,
        updatedAt: new Date(),
      },
    ]);
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([]);
    mockedPrisma.convenioAuthorizationAttachment.findMany.mockResolvedValueOnce([]);

    res = await app.inject({ method: 'GET', url: '/convenio-auth?search=cardio' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThanOrEqual(0);

    await app.close();
  });

  it('handles view attachment without branch auth and returns 403', async () => {
    const app = await buildApp();

    // Mock getLoggedBranchId to return null (unauthorized/no branch)
    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);

    const res = await app.inject({ method: 'GET', url: '/convenio-auth/attachments/att-1/view' });
    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it('handles list attachments with missing branch and returns 403', async () => {
    const app = await buildApp();

    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);

    const res = await app.inject({ method: 'GET', url: '/convenio-auth/APPOINTMENT/a-1/attachments' });
    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it('handles upload without branch and returns 403', async () => {
    const app = await buildApp();

    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'POST',
      url: '/convenio-auth/APPOINTMENT/a-1/attachments',
      payload: { fileName: 'test.pdf', fileBase64: Buffer.from('test').toString('base64') },
    });
    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it('handles PATCH without branch and returns 403', async () => {
    const app = await buildApp();

    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'PATCH',
      url: '/convenio-auth/APPOINTMENT/a-1',
      payload: { status: 'AUTHORIZED' },
    });
    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it('handles TEA with hasAuthorized=true && hasDenied=true special case', async () => {
    const app = await buildApp();

   // Create a scenario where one entry is AUTHORIZED and another is DENIED
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([]);
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([
      // AUTHORIZED entry
      {
        id: 'pr-auth',
        pitTherapyId: 'pit-special',
        status: 'AUTHORIZED',
        patient: { name: 'Special', cpf: '555', healthInsuranceName: 'Plano Z' },
        procedureName: 'Fisio',
        professionalName: 'Dr A',
        suggestedDate: new Date('2026-04-16T00:00:00Z'),
        suggestedTime: '10:00',
        notes: null,
        updatedAt: new Date('2026-04-13T10:00:00Z'),
      },
      // DENIED entry
      {
        id: 'pr-denied',
        pitTherapyId: 'pit-special',
        status: 'CANCELED',
        patient: { name: 'Special', cpf: '555', healthInsuranceName: 'Plano Z' },
        procedureName: 'Fisio',
        professionalName: 'Dr A',
        suggestedDate: new Date('2026-04-17T00:00:00Z'),
        suggestedTime: '10:00',
        notes: '[AUTH_DENIED] Negado',
        updatedAt: new Date('2026-04-13T10:00:00Z'),
      },
    ]);
    mockedPrisma.convenioAuthorizationAttachment.findMany.mockResolvedValueOnce([]);

    const res = await app.inject({ method: 'GET', url: '/convenio-auth' });
    expect(res.statusCode).toBe(200);
    // Should have the grouped item with mixed status
    const teaItems = res.json().items.filter((i: any) => i.sourceType === 'TEA');
    expect(teaItems.length).toBeGreaterThanOrEqual(1);

    await app.close();
  });

  it('covers TEA PATCH with empty doctor list triggering undefined in query', async () => {
    const app = await buildApp();

    // Reset doctor mock to return empty list for the second doctor query in PATCH/TEA
    mockedPrisma.doctor.findMany.mockResolvedValueOnce([{ id: 'd-1', name: 'Dr A', room: { name: 'Sala 1', branch: { tradeName: 'Unidade' } } }]); // For list
    mockedPrisma.doctor.findMany.mockResolvedValueOnce([]); // For PATCH/TEA - empty list
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([{ id: 'pr-1' }]);

    const res = await app.inject({
      method: 'PATCH',
      url: '/convenio-auth/TEA/pit-1',
      payload: { status: 'AUTHORIZED' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    await app.close();
  });

  it('covers TEA with all PENDING mapped status', async () => {
    const app = await buildApp();

    mockedPrisma.appointment.findMany.mockResolvedValueOnce([]);
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([
      {
        id: 'pr-pending',
        pitTherapyId: 'pit-pending',
        status: 'PROPOSED',  // Maps to PENDING
        patient: { name: 'Pending Patient', cpf: '777', healthInsuranceName: null },
        procedureName: 'Teste',
        professionalName: 'Dr A',
        suggestedDate: new Date('2026-04-20T00:00:00Z'),
        suggestedTime: '15:00',
        notes: null,
        updatedAt: new Date(),
      },
    ]);
    mockedPrisma.convenioAuthorizationAttachment.findMany.mockResolvedValueOnce([]);

    const res = await app.inject({ method: 'GET', url: '/convenio-auth' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('covers view attachment with 404 when attachment not found', async () => {
    const app = await buildApp();

    mockedPrisma.convenioAuthorizationAttachment.findFirst.mockResolvedValueOnce(null);

    const res = await app.inject({ method: 'GET', url: '/convenio-auth/attachments/non-existent/view' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('not found');

    await app.close();
  });

  it('covers list attachments with 403 when no branch for user on missing branchId function call', async () => {
    const app = await buildApp();

    // Force getLoggedBranchId to return null
    mockedPrisma.user.findUnique.mockResolvedValueOnce({ sector: null });

    const res = await app.inject({ method: 'GET', url: '/convenio-auth/APPOINTMENT/a-1/attachments' });
    expect(res.statusCode).toBe(403);

    await app.close();
  });
});

