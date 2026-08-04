import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import teaPreReservationsRoutes from '../../src/modules/care/routes/tea-pre-reservations';
import prisma from '../../src/modules/care/lib/prisma';

vi.mock('../../src/modules/care/lib/appointment-whatsapp-events', () => ({
  publishAppointmentCreatedEvent: vi.fn(),
}));

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    teaPitTherapy: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    teaPreReservation: { findMany: vi.fn(), count: vi.fn(), create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    teaPreReservationTimeline: { create: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
    convenioAuthorizationAttachment: { findMany: vi.fn() },
    appointment: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    doctor: { findFirst: vi.fn(), findMany: vi.fn() },
    procedureDoctor: { findFirst: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const mockedPrisma = prisma as any;

async function buildApp() {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    this.user = { id: 'u-1' };
  });
  await app.register(teaPreReservationsRoutes, { prefix: '/tpr' });
  return app;
}

describe('care tea-pre-reservations routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mockedPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', sector: { branch: { id: 'b-1' } } });
    mockedPrisma.teaPitTherapy.findMany.mockResolvedValue([]);
    mockedPrisma.teaPitTherapy.findFirst.mockResolvedValue({
      id: 'pit-1',
      isActive: true,
      weeklyFrequency: 2,
      preferredWeekdays: ['SEGUNDA'],
      preferredShift: 'MANHA',
      durationMinutes: 45,
      therapyType: 'TO',
      pit: {
        teaProfile: {
          patient: { id: 'p-1', name: 'Maria', cpf: '11144477735' },
        },
      },
    });
    mockedPrisma.teaPreReservation.findMany.mockResolvedValue([]);
    mockedPrisma.teaPreReservation.count.mockResolvedValue(0);
    mockedPrisma.teaPreReservation.create.mockResolvedValue({
      id: 'pr-1',
      status: 'PROPOSED',
      suggestedDate: new Date('2026-04-14T00:00:00Z'),
      suggestedTime: '09:00',
    });
    mockedPrisma.teaPreReservation.findFirst.mockResolvedValue({
      id: 'pr-1',
      pitId: 'pit-main',
      pitTherapyId: 'pit-1',
      patient: { id: 'p-1', name: 'Maria', cpf: '11144477735', healthInsuranceName: 'Plano X', branchId: 'b-1' },
      status: 'AUTHORIZED',
      suggestedDate: new Date('2026-04-14T00:00:00Z'),
      suggestedTime: '09:00',
      professionalName: 'Dra. Ana',
      procedureName: 'TO',
      durationMinutes: 45,
      expiresAt: null,
      createdAt: new Date('2026-04-13T10:00:00Z'),
    });
    mockedPrisma.teaPreReservation.update.mockResolvedValue({ id: 'pr-1', status: 'AUTHORIZED' });
    mockedPrisma.teaPreReservation.updateMany.mockResolvedValue({ count: 0 });
    mockedPrisma.convenioAuthorizationAttachment.findMany.mockResolvedValue([]);
    mockedPrisma.appointment.findMany.mockResolvedValue([]);
    mockedPrisma.appointment.findFirst.mockResolvedValue(null);
    mockedPrisma.appointment.create.mockResolvedValue({ id: 'a-1' });
    mockedPrisma.appointment.updateMany.mockResolvedValue({ count: 0 });
    mockedPrisma.doctor.findFirst.mockResolvedValue(null);
    mockedPrisma.doctor.findMany.mockResolvedValue([]);
    mockedPrisma.procedureDoctor.findFirst.mockResolvedValue(null);
    mockedPrisma.procedureDoctor.findMany.mockResolvedValue([]);
    mockedPrisma.teaPitTherapy.updateMany.mockResolvedValue({ count: 0 });
    mockedPrisma.teaPreReservationTimeline.create.mockResolvedValue({ id: 'tl-1' });
    mockedPrisma.teaPreReservationTimeline.createMany.mockResolvedValue({ count: 0 });
    mockedPrisma.teaPreReservationTimeline.findMany.mockResolvedValue([]);
    mockedPrisma.$transaction.mockImplementation(async (arg: any) => {
      if (typeof arg === 'function') {
        return arg({
          teaPreReservation: { updateMany: vi.fn() },
          teaPreReservationTimeline: { createMany: vi.fn() },
          appointment: { create: vi.fn().mockResolvedValue({ id: 'a-1' }), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
          teaPitTherapy: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        });
      }
      return undefined;
    });
  });

  it('returns 500 when prisma models are unavailable on pending route', async () => {
    const app = await buildApp();

    const original = mockedPrisma.teaPitTherapy;
    mockedPrisma.teaPitTherapy = undefined;

    const res = await app.inject({ method: 'GET', url: '/tpr/pending' });

    expect(res.statusCode).toBe(500);

    mockedPrisma.teaPitTherapy = original;
    await app.close();
  });

  it('lists pending items with empty sources', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/tpr/pending?status=PENDING_SCHEDULING&search=maria' });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
    expect(res.json().summary.totalPendingScheduling).toBe(0);

    await app.close();
  });

  it('lists created pre-reservations and aggregates authorization docs', async () => {
    const app = await buildApp();

    mockedPrisma.teaPreReservation.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'pr-1',
          pitTherapyId: 'pt-1',
          createdAt: new Date('2026-04-13T10:00:00Z'),
          patient: { id: 'p-1', name: 'Maria', cpf: '11144477735', birthDate: new Date('1990-01-01T00:00:00Z') },
        },
      ]);
    mockedPrisma.teaPreReservation.count.mockResolvedValueOnce(1);
    mockedPrisma.convenioAuthorizationAttachment.findMany.mockResolvedValueOnce([
      { id: 'doc-1', pitTherapyId: 'pt-1', fileName: 'guia.pdf', uploadedAt: new Date('2026-04-13T09:00:00Z') },
    ]);

    const res = await app.inject({ method: 'GET', url: '/tpr?status=AUTHORIZED&limit=10&offset=0' });

    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().items[0].authorizationAttachmentsCount).toBe(1);

    await app.close();
  });

  it('validates weekly payload and handles missing / unknown therapy', async () => {
    const app = await buildApp();

    let res = await app.inject({
      method: 'POST',
      url: '/tpr/validate-weekly',
      payload: { suggestions: [] },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.teaPitTherapy.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({
      method: 'POST',
      url: '/tpr/validate-weekly',
      payload: { pitTherapyId: 'pit-x', suggestions: [] },
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('validates weekly assignment counts', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/validate-weekly',
      payload: {
        pitTherapyId: 'pit-1',
        suggestions: [
          { date: '2026-04-13', time: '09:00' },
          { date: '2026-04-14', time: '09:00' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().pitTherapyId).toBe('pit-1');
    expect(typeof res.json().valid).toBe('boolean');

    await app.close();
  });

  it('returns 400 for invalid manual-grid weekStart', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/tpr/pit-1/manual-grid?weekStart=invalid-date',
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 404 for suggestions when therapy is missing', async () => {
    const app = await buildApp();
    mockedPrisma.teaPitTherapy.findFirst.mockResolvedValueOnce(null);

    const res = await app.inject({ method: 'GET', url: '/tpr/pit-x/suggestions' });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns empty suggestions when no candidate doctors are found', async () => {
    const app = await buildApp();
    mockedPrisma.teaPitTherapy.findFirst.mockResolvedValueOnce({
      id: 'pit-1',
      isActive: true,
      preferredWeekdays: ['SEGUNDA'],
      preferredShift: 'MANHA',
      pit: { teaProfile: { patient: { id: 'p-1', name: 'Maria', cpf: '11144477735' } } },
    });

    const res = await app.inject({ method: 'GET', url: '/tpr/pit-1/suggestions?daysAhead=7&limit=3' });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
    await app.close();
  });

  it('returns suggestions when doctor has availability', async () => {
    const app = await buildApp();
    mockedPrisma.teaPitTherapy.findFirst.mockResolvedValueOnce({
      id: 'pit-1',
      isActive: true,
      professionalDoctorId: 'd-1',
      preferredWeekdays: ['SEGUNDA'],
      preferredShift: 'MANHA',
      durationMinutes: 45,
      pit: { teaProfile: { patient: { id: 'p-1', name: 'Maria', cpf: '11144477735' } } },
    });
    mockedPrisma.doctor.findFirst.mockResolvedValueOnce({
      id: 'd-1',
      name: 'Dra. Ana',
      isActive: true,
      workingDays: ['SEGUNDA'],
      workingHoursStart: '08:00',
      workingHoursEnd: '12:00',
      workingSchedules: [],
    });

    const res = await app.inject({ method: 'GET', url: '/tpr/pit-1/suggestions?daysAhead=7&limit=2' });

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().items)).toBe(true);
    await app.close();
  });

  it('does not stack same-day suggestions closer together than the procedure duration', async () => {
    const app = await buildApp();
    mockedPrisma.teaPitTherapy.findFirst.mockResolvedValueOnce({
      id: 'pit-1',
      isActive: true,
      professionalDoctorId: 'd-1',
      preferredWeekdays: ['SEGUNDA'],
      preferredShift: 'MANHA',
      durationMinutes: 45,
      therapyType: 'Psicomotricidade',
      pit: { teaProfile: { patient: { id: 'p-1', name: 'Davi', cpf: '11144477735' } } },
    });
    mockedPrisma.doctor.findFirst.mockResolvedValueOnce({
      id: 'd-1',
      name: 'Dra. Beatriz',
      isActive: true,
      workingDays: ['SEGUNDA'],
      workingHoursStart: '08:00',
      workingHoursEnd: '12:00',
      workingSchedules: [],
    });

    const res = await app.inject({ method: 'GET', url: '/tpr/pit-1/suggestions?daysAhead=7&limit=10' });

    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ date: string; time: string }>;
    const byDate = new Map<string, string[]>();
    items.forEach((item) => {
      const times = byDate.get(item.date) || [];
      times.push(item.time);
      byDate.set(item.date, times);
    });

    const toMinutes = (t: string) => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };

    byDate.forEach((times) => {
      const sorted = [...times].sort();
      for (let i = 1; i < sorted.length; i += 1) {
        expect(toMinutes(sorted[i]) - toMinutes(sorted[i - 1])).toBeGreaterThanOrEqual(45);
      }
    });
    await app.close();
  });

  it('returns suggestions when therapy has no preferred shift and doctor has no explicit working window', async () => {
    const app = await buildApp();
    mockedPrisma.teaPitTherapy.findFirst.mockResolvedValueOnce({
      id: 'pit-1',
      isActive: true,
      professionalDoctorId: 'd-1',
      preferredWeekdays: [],
      preferredShift: null,
      durationMinutes: 45,
      therapyType: 'TO',
      pit: { teaProfile: { patient: { id: 'p-1', name: 'Maria', cpf: '11144477735' } } },
    });
    mockedPrisma.doctor.findFirst.mockResolvedValueOnce({
      id: 'd-1',
      name: 'Dra. Ana',
      isActive: true,
      workingDays: [],
      workingHoursStart: null,
      workingHoursEnd: null,
      workingSchedules: [],
    });

    const res = await app.inject({ method: 'GET', url: '/tpr/pit-1/suggestions?daysAhead=3&limit=1' });

    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBeGreaterThan(0);
    await app.close();
  });

  it('returns 404 for manual-grid when therapy is inactive', async () => {
    const app = await buildApp();
    mockedPrisma.teaPitTherapy.findFirst.mockResolvedValueOnce({ id: 'pit-1', isActive: false });

    const res = await app.inject({ method: 'GET', url: '/tpr/pit-1/manual-grid' });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns manual-grid data successfully', async () => {
    const app = await buildApp();
    mockedPrisma.doctor.findMany.mockResolvedValueOnce([
      {
        id: 'd-1',
        name: 'Dra. Ana',
        isActive: true,
        workingDays: ['SEGUNDA', 'TERCA', 'QUARTA', 'QUINTA', 'SEXTA'],
        workingHoursStart: '08:00',
        workingHoursEnd: '12:00',
        workingSchedules: [],
      },
    ]);

    const res = await app.inject({ method: 'GET', url: '/tpr/pit-1/manual-grid?weekStart=2026-04-13' });

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().days)).toBe(true);
    await app.close();
  });

  it('returns manual-grid data when doctor schedules json is invalid and preferred shift is unsupported', async () => {
    const app = await buildApp();
    mockedPrisma.teaPitTherapy.findFirst.mockResolvedValueOnce({
      id: 'pit-1',
      isActive: true,
      preferredWeekdays: ['MONDAY'],
      preferredShift: 'MADRUGADA',
      durationMinutes: 45,
      professionalDoctorId: null,
      procedureId: null,
      therapyType: 'TO',
      pit: { teaProfile: { patient: { id: 'p-1', name: 'Maria', cpf: '11144477735' } } },
    });
    mockedPrisma.doctor.findMany.mockResolvedValueOnce([
      {
        id: 'd-2',
        name: 'Dr. Bruno',
        isActive: true,
        workingDays: [],
        workingHoursStart: null,
        workingHoursEnd: null,
        workingSchedules: 'not-json',
      },
    ]);

    const res = await app.inject({ method: 'GET', url: '/tpr/pit-1/manual-grid?weekStart=2026-04-13' });

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().days)).toBe(true);
    await app.close();
  });

  it('validates create payload for missing pitTherapyId', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'POST', url: '/tpr', payload: {} });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 404 when creating for unknown therapy', async () => {
    const app = await buildApp();
    mockedPrisma.teaPitTherapy.findFirst.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'POST',
      url: '/tpr',
      payload: { pitTherapyId: 'pit-x' },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 400 when creating with invalid suggestedDate', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/tpr',
      payload: { pitTherapyId: 'pit-1', suggestedDate: 'invalid-date', suggestedTime: '09:00' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 409 when creating with schedule conflicts', async () => {
    const app = await buildApp();
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([{ id: 'a-1', time: '09:00', durationMinutes: 45 }]);

    const res = await app.inject({
      method: 'POST',
      url: '/tpr',
      payload: { pitTherapyId: 'pit-1', suggestedDate: '2026-04-14', suggestedTime: '09:00' },
    });

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('creates non-recurring pre-reservation successfully', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/tpr',
      payload: { pitTherapyId: 'pit-1', suggestedDate: '2026-04-14', suggestedTime: '09:00' },
    });

    expect(res.statusCode).toBe(201);
    expect(mockedPrisma.teaPreReservation.create).toHaveBeenCalled();
    await app.close();
  });

  it('validates recurring creation requiring date/time', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/tpr',
      payload: { pitTherapyId: 'pit-1', recurring: true },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('validates recurring creation requiring doctor configured in PIT', async () => {
    const app = await buildApp();
    mockedPrisma.teaPitTherapy.findFirst.mockResolvedValueOnce({
      id: 'pit-1',
      isActive: true,
      professionalDoctorId: null,
      professional: null,
      pitId: 'pit-main',
      teaProfileId: 'tp-1',
      durationMinutes: 45,
      therapyType: 'TO',
      pit: { teaProfile: { patient: { id: 'p-1' } } },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/tpr',
      payload: { pitTherapyId: 'pit-1', recurring: true, suggestedDate: '2026-04-14', suggestedTime: '09:00' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 for recurring creation with invalid suggestedDate', async () => {
    const app = await buildApp();

    mockedPrisma.teaPitTherapy.findFirst.mockResolvedValueOnce({
      id: 'pit-1',
      isActive: true,
      professionalDoctorId: 'd-1',
      professional: 'Dra. Ana',
      pitId: 'pit-main',
      teaProfileId: 'tp-1',
      durationMinutes: 45,
      therapyType: 'TO',
      pit: { teaProfile: { patient: { id: 'p-1' } } },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/tpr',
      payload: {
        pitTherapyId: 'pit-1',
        recurring: true,
        suggestedDate: 'not-a-date',
        suggestedTime: '09:00',
      },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('creates recurring reservations and counts skipped conflicts', async () => {
    const app = await buildApp();

    mockedPrisma.teaPitTherapy.findFirst.mockResolvedValueOnce({
      id: 'pit-1',
      isActive: true,
      professionalDoctorId: 'd-1',
      professional: 'Dra. Ana',
      pitId: 'pit-main',
      teaProfileId: 'tp-1',
      durationMinutes: 45,
      therapyType: 'TO',
      pit: { teaProfile: { patient: { id: 'p-1' } } },
    });

    mockedPrisma.appointment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'a-conflict', time: '09:00', durationMinutes: 45 }]);
    mockedPrisma.teaPreReservation.findMany.mockResolvedValue([]);

    const res = await app.inject({
      method: 'POST',
      url: '/tpr',
      payload: {
        pitTherapyId: 'pit-1',
        recurring: true,
        recurrenceWeeks: 2,
        suggestedDate: '2099-01-05',
        suggestedTime: '09:00',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().totalCreated).toBe(1);
    expect(res.json().skippedConflicts).toBe(1);
    expect(mockedPrisma.teaPreReservation.create).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('validates accept-group payload requiring items', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/accept-group',
      payload: { items: [] },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 when validate-weekly receives empty pitTherapyId', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/validate-weekly',
      payload: { pitTherapyId: '', suggestions: [] },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('accepts group items and creates reservations', async () => {
    const app = await buildApp();
    mockedPrisma.doctor.findMany.mockResolvedValueOnce([
      {
        id: 'd-1',
        name: 'Dra. Ana',
        isActive: true,
        workingDays: ['SEGUNDA'],
        workingHoursStart: '08:00',
        workingHoursEnd: '12:00',
        workingSchedules: [],
      },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/accept-group',
      payload: {
        items: [
          {
            pitTherapyId: 'pit-1',
            suggestedDate: '2026-04-13',
            suggestedTime: '09:00',
            professionalDoctorId: 'd-1',
          },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().totalCreated).toBeGreaterThanOrEqual(1);
    expect(mockedPrisma.teaPreReservation.create).toHaveBeenCalled();
    await app.close();
  });

  it('accept-group skips item when no doctor is available', async () => {
    const app = await buildApp();
    mockedPrisma.doctor.findMany.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/accept-group',
      payload: {
        items: [
          {
            pitTherapyId: 'pit-1',
            suggestedDate: '2026-04-13',
            suggestedTime: '09:00',
          },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().totalCreated).toBe(0);
    expect(res.json().skippedConflicts).toBe(1);
    await app.close();
  });

  it('accept-group skips item with invalid suggested date and stops recurring series after until date', async () => {
    const app = await buildApp();
    mockedPrisma.doctor.findMany.mockResolvedValue([
      {
        id: 'd-1',
        name: 'Dra. Ana',
        isActive: true,
        workingDays: ['SEGUNDA'],
        workingHoursStart: '08:00',
        workingHoursEnd: '12:00',
        workingSchedules: [],
      },
    ]);

    let res = await app.inject({
      method: 'POST',
      url: '/tpr/accept-group',
      payload: {
        items: [
          {
            pitTherapyId: 'pit-1',
            suggestedDate: 'invalid-date',
            suggestedTime: '09:00',
            professionalDoctorId: 'd-1',
          },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().totalCreated).toBe(0);

    mockedPrisma.teaPreReservation.create.mockClear();
    res = await app.inject({
      method: 'POST',
      url: '/tpr/accept-group',
      payload: {
        recurring: true,
        recurrenceWeeks: 5,
        recurringUntilDate: '2026-04-13T23:59:59Z',
        items: [
          {
            pitTherapyId: 'pit-1',
            suggestedDate: '2026-04-13',
            suggestedTime: '09:00',
            professionalDoctorId: 'd-1',
          },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().totalCreated).toBe(1);
    expect(mockedPrisma.teaPreReservation.create).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('accept-group replaces existing open series when requested with explicit status', async () => {
    const app = await buildApp();

    mockedPrisma.teaPitTherapy.findFirst.mockResolvedValueOnce({
      id: 'pit-1',
      isActive: true,
      pitId: 'pit-main',
      teaProfileId: 'tp-1',
      weeklyFrequency: 2,
      preferredWeekdays: ['SEGUNDA'],
      preferredShift: 'MANHA',
      durationMinutes: 45,
      therapyType: 'TO',
      professionalDoctorId: 'd-1',
      professional: 'Dra. Ana',
      pit: {
        teaProfile: {
          patient: { id: 'p-1', name: 'Maria', cpf: '11144477735' },
        },
      },
    });

    mockedPrisma.doctor.findMany.mockResolvedValueOnce([
      {
        id: 'd-1',
        name: 'Dra. Ana',
        isActive: true,
        workingDays: ['SEGUNDA', 'TERCA', 'QUARTA', 'QUINTA', 'SEXTA', 'SABADO', 'DOMINGO'],
        workingHoursStart: '08:00',
        workingHoursEnd: '18:00',
        workingSchedules: [],
      },
    ]);

    mockedPrisma.teaPreReservation.findMany.mockImplementation((args: any) => {
      if (args?.where?.pitTherapyId === 'pit-1') {
        return Promise.resolve([{ id: 'open-1' }, { id: 'open-2' }]);
      }
      return Promise.resolve([]);
    });

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/accept-group',
      payload: {
        replaceExistingByTherapy: true,
        status: 'AUTHORIZED',
        items: [
          {
            pitTherapyId: 'pit-1',
            suggestedDate: '2099-01-05',
            suggestedTime: '09:00',
            professionalDoctorId: 'd-1',
          },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().totalCreated).toBeGreaterThanOrEqual(1);
    expect(mockedPrisma.teaPreReservation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'CANCELED',
      }),
    }));
    expect(mockedPrisma.teaPreReservation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'AUTHORIZED',
      }),
    }));

    await app.close();
  });

  it('accept-group infers pending authorization when weekly frequency increase is pending', async () => {
    const app = await buildApp();

    mockedPrisma.doctor.findMany.mockResolvedValueOnce([
      {
        id: 'd-1',
        name: 'Dra. Ana',
        isActive: true,
        workingDays: ['SEGUNDA', 'TERCA', 'QUARTA', 'QUINTA', 'SEXTA', 'SABADO', 'DOMINGO'],
        workingHoursStart: '08:00',
        workingHoursEnd: '18:00',
        workingSchedules: [],
      },
    ]);

    mockedPrisma.teaPitTherapy.findFirst.mockResolvedValue({
      id: 'pit-1',
      isActive: true,
      weeklyFrequency: 2,
      preferredWeekdays: ['SEGUNDA'],
      preferredShift: 'MANHA',
      durationMinutes: 45,
      therapyType: 'TO',
      professionalDoctorId: 'd-1',
      professional: 'Dra. Ana',
      pitId: 'pit-main',
      teaProfileId: 'tp-1',
      pit: {
        teaProfile: {
          patient: { id: 'p-1', name: 'Maria', cpf: '11144477735' },
        },
      },
    });

    mockedPrisma.teaPreReservation.findMany.mockImplementation((args: any) => {
      if (args?.where?.status === 'CONVERTED') {
        return Promise.resolve([
          {
            suggestedDate: new Date('2099-01-05T00:00:00Z'),
            suggestedTime: '09:00',
          },
        ]);
      }
      return Promise.resolve([]);
    });

    mockedPrisma.appointment.findMany.mockImplementation((args: any) => {
      if (args?.where?.type === 'RETORNO TEA') {
        return Promise.resolve([
          {
            date: '2099-01-05',
            time: '09:00',
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/accept-group',
      payload: {
        items: [
          {
            pitTherapyId: 'pit-1',
            suggestedDate: '2099-01-05',
            suggestedTime: '10:00',
            professionalDoctorId: 'd-1',
          },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().totalCreated).toBeGreaterThanOrEqual(1);
    expect(mockedPrisma.teaPreReservation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'PENDING_AUTHORIZATION',
      }),
    }));

    await app.close();
  });

  it('validates status patch with invalid status value', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/tpr/pr-1/status',
      payload: { status: 'invalid' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 404 when patching status for unknown reservation', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findFirst.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'PATCH',
      url: '/tpr/pr-x/status',
      payload: { status: 'AUTHORIZED' },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('updates reservation status successfully', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/tpr/pr-1/status',
      payload: { status: 'AUTHORIZED', notes: 'ok' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.teaPreReservation.update).toHaveBeenCalled();
    await app.close();
  });

  it('bypasses pending authorization to authorized when therapy already has active converted sessions', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findFirst
      .mockResolvedValueOnce({
        id: 'pr-1',
        pitId: 'pit-main',
        pitTherapyId: 'pit-1',
        status: 'PROPOSED',
      })
      .mockResolvedValueOnce({ id: 'existing-authorized' });
    mockedPrisma.teaPitTherapy.findFirst.mockResolvedValueOnce({
      id: 'pit-1',
      isActive: true,
      weeklyFrequency: 1,
      pit: { teaProfile: { patient: { id: 'p-1' } } },
    });
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([
      { suggestedDate: new Date('2026-04-14T12:00:00Z'), suggestedTime: '09:00' },
    ]);
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([
      { date: '2026-04-14', time: '09:00' },
    ]);
    mockedPrisma.teaPreReservation.update.mockResolvedValueOnce({ id: 'pr-1', status: 'AUTHORIZED' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/tpr/pr-1/status',
      payload: { status: 'PENDING_AUTHORIZATION' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.teaPreReservation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'AUTHORIZED' }),
    }));
    await app.close();
  });

  it('updates single reservation status to converted with explicit convertedAt', async () => {
    const app = await buildApp();

    mockedPrisma.teaPreReservation.update.mockResolvedValueOnce({ id: 'pr-1', status: 'CONVERTED' });
    const res = await app.inject({
      method: 'PATCH',
      url: '/tpr/pr-1/status',
      payload: { status: 'CONVERTED', convertedAt: '2026-04-21T10:00:00Z' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.teaPreReservation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'CONVERTED' }),
    }));
    await app.close();
  });

  it('updates single reservation status to proposed with generated expiration', async () => {
    const app = await buildApp();

    mockedPrisma.teaPreReservation.update.mockResolvedValueOnce({ id: 'pr-1', status: 'PROPOSED' });
    const res = await app.inject({
      method: 'PATCH',
      url: '/tpr/pr-1/status',
      payload: { status: 'PROPOSED', notes: '' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.teaPreReservation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PROPOSED', notes: null }),
    }));
    await app.close();
  });

  it('updates single reservation status to proposed with explicit expiration', async () => {
    const app = await buildApp();

    mockedPrisma.teaPreReservation.update.mockResolvedValueOnce({ id: 'pr-1', status: 'PROPOSED' });
    const res = await app.inject({
      method: 'PATCH',
      url: '/tpr/pr-1/status',
      payload: { status: 'PROPOSED', expiresAt: '2026-04-25T10:00:00Z' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.teaPreReservation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        expiresAt: new Date('2026-04-25T10:00:00Z'),
      }),
    }));
    await app.close();
  });

  it('updates status in series when applySeries is true', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([
      { id: 'pr-1', status: 'PROPOSED', createdAt: new Date('2026-04-10T10:00:00Z') },
      { id: 'pr-2', status: 'PROPOSED', createdAt: new Date('2026-04-11T10:00:00Z') },
    ]);
    mockedPrisma.teaPreReservation.update
      .mockResolvedValueOnce({ id: 'pr-1', status: 'CANCELED' })
      .mockResolvedValueOnce({ id: 'pr-2', status: 'CANCELED' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/tpr/pr-1/status',
      payload: { status: 'CANCELED', applySeries: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().updatedCount).toBe(2);
    await app.close();
  });

  it('updates status in series with explicit dates for proposed and authorized branches', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([
      { id: 'pr-1', status: 'PENDING_AUTHORIZATION', createdAt: new Date('2026-04-10T10:00:00Z') },
    ]);
    mockedPrisma.teaPreReservation.update.mockResolvedValueOnce({ id: 'pr-1', status: 'PROPOSED' });

    let res = await app.inject({
      method: 'PATCH',
      url: '/tpr/pr-1/status',
      payload: { status: 'PROPOSED', applySeries: true, expiresAt: '2026-04-20T10:00:00Z', notes: '' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().updatedCount).toBe(1);

    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([
      { id: 'pr-2', status: 'PROPOSED', createdAt: new Date('2026-04-11T10:00:00Z') },
    ]);
    mockedPrisma.teaPreReservation.update.mockResolvedValueOnce({ id: 'pr-2', status: 'AUTHORIZED' });

    res = await app.inject({
      method: 'PATCH',
      url: '/tpr/pr-2/status',
      payload: { status: 'AUTHORIZED', applySeries: true, authorizedAt: '2026-04-21T10:00:00Z' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().updatedCount).toBe(1);
    await app.close();
  });

  it('validates cancellation-therapies query parameters', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/tpr/cancellation-therapies' });

    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'GET', url: '/tpr/cancellation-therapies?teaProfileId=' });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields.teaProfileId).toBe('teaProfileId é obrigatório');

    res = await app.inject({ method: 'GET', url: '/tpr/cancellation-therapies?teaProfileId=tp-1&fromDate=invalid-date' });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('returns empty cancellation-therapies when no converted reservations exist', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([]);

    const res = await app.inject({ method: 'GET', url: '/tpr/cancellation-therapies?teaProfileId=tp-1' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], total: 0 });
    await app.close();
  });

  it('returns empty cancellation-therapies when converted reservations have no patient id', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([
      {
        id: 'pr-1',
        status: 'CONVERTED',
        suggestedDate: new Date('2026-04-14T00:00:00Z'),
        suggestedTime: '09:00',
        patientId: null,
        pitTherapyId: 'pit-1',
        pitTherapy: { id: 'pit-1', isActive: true },
      },
    ]);

    const res = await app.inject({ method: 'GET', url: '/tpr/cancellation-therapies?teaProfileId=tp-1' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], total: 0 });
    await app.close();
  });

  it('groups cancellation-therapies from active converted reservations with active appointments', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([
      {
        id: 'pr-1',
        status: 'CONVERTED',
        patientId: 'p-1',
        pitTherapyId: 'pit-1',
        procedureName: '',
        professionalName: '',
        suggestedDate: new Date('2026-04-14T12:00:00Z'),
        suggestedTime: '09:00',
        pitTherapy: {
          id: 'pit-1',
          isActive: true,
          therapyType: 'TO',
          professional: 'Dra. Ana',
          weeklyFrequency: 2,
          preferredWeekdays: ['TERCA'],
          preferredShift: 'MANHA',
        },
      },
      {
        id: 'pr-dup',
        status: 'CONVERTED',
        patientId: 'p-1',
        pitTherapyId: 'pit-1',
        procedureName: 'TO',
        professionalName: 'Dra. Ana',
        suggestedDate: new Date('2026-04-14T12:00:00Z'),
        suggestedTime: '09:00',
        pitTherapy: {
          id: 'pit-1',
          isActive: true,
          therapyType: 'TO',
          professional: 'Dra. Ana',
          weeklyFrequency: 2,
          preferredWeekdays: ['TERCA'],
          preferredShift: 'MANHA',
        },
      },
      {
        id: 'pr-later',
        status: 'CONVERTED',
        patientId: 'p-1',
        pitTherapyId: 'pit-1',
        procedureName: 'TO',
        professionalName: 'Dra. Ana',
        suggestedDate: new Date('2026-04-14T12:00:00Z'),
        suggestedTime: '10:00',
        pitTherapy: {
          id: 'pit-1',
          isActive: true,
          therapyType: 'TO',
          professional: 'Dra. Ana',
          weeklyFrequency: 2,
          preferredWeekdays: ['TERCA'],
          preferredShift: 'MANHA',
        },
      },
      {
        id: 'pr-inactive-therapy',
        status: 'CONVERTED',
        patientId: 'p-1',
        pitTherapyId: 'pit-2',
        suggestedDate: new Date('2026-04-15T00:00:00Z'),
        suggestedTime: '10:00',
        pitTherapy: { id: 'pit-2', isActive: false },
      },
    ]);
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([
      { id: 'a-1', date: '2026-04-14', time: '09:00' },
      { id: 'a-2', date: '2026-04-14', time: '10:00' },
    ]);

    const res = await app.inject({ method: 'GET', url: '/tpr/cancellation-therapies?teaProfileId=tp-1&fromDate=2026-04-01' });

    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().items[0].pitTherapyId).toBe('pit-1');
    expect(res.json().items[0].totalSessions).toBe(2);
    expect(res.json().items[0].slots.map((slot: any) => slot.time)).toEqual(['09:00', '10:00']);
    await app.close();
  });

  it('validates cancel-therapy-series weekday index range', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/cancel-therapy-series',
      payload: { teaProfileId: 'tp-1', cancelAll: true, weekdayIndex: 10 },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('validates required fields and fromDate in cancel-therapy-series', async () => {
    const app = await buildApp();

    let res = await app.inject({
      method: 'POST',
      url: '/tpr/cancel-therapy-series',
      payload: { cancelAll: false },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/tpr/cancel-therapy-series',
      payload: { teaProfileId: 'tp-1', cancelAll: false },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields.pitTherapyId).toBe('pitTherapyId é obrigatório');

    res = await app.inject({
      method: 'POST',
      url: '/tpr/cancel-therapy-series',
      payload: { teaProfileId: '', cancelAll: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields.teaProfileId).toBe('teaProfileId é obrigatório');

    res = await app.inject({
      method: 'POST',
      url: '/tpr/cancel-therapy-series',
      payload: { teaProfileId: 'tp-1', pitTherapyId: 'pit-1', fromDate: 'invalid-date' },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('returns zero cancellation counts when reservations are empty or missing patient id', async () => {
    const app = await buildApp();

    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([]);
    let res = await app.inject({
      method: 'POST',
      url: '/tpr/cancel-therapy-series',
      payload: { teaProfileId: 'tp-1', pitTherapyId: 'pit-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().affectedReservations).toBe(0);

    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([
      {
        id: 'pr-no-patient',
        patientId: null,
        pitTherapyId: 'pit-1',
        suggestedDate: new Date('2026-04-14T00:00:00Z'),
        suggestedTime: '09:00',
      },
    ]);
    res = await app.inject({
      method: 'POST',
      url: '/tpr/cancel-therapy-series',
      payload: { teaProfileId: 'tp-1', pitTherapyId: 'pit-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().affectedReservations).toBe(0);

    await app.close();
  });

  it('cancels therapy series and returns affected count', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([
      {
        id: 'pr-1',
        patientId: 'p-1',
        pitTherapyId: 'pit-1',
        suggestedDate: new Date('2026-04-13T00:00:00Z'),
        suggestedTime: '09:00',
      },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/cancel-therapy-series',
      payload: {
        teaProfileId: 'tp-1',
        pitTherapyId: 'pit-1',
        cancelAll: false,
        reason: 'teste',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().affectedReservations).toBe(1);
    await app.close();
  });

  it('cancels therapy series without reason using default PIT removal note', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([
      {
        id: 'pr-1',
        patientId: 'p-1',
        pitTherapyId: 'pit-1',
        suggestedDate: new Date('2026-04-13T00:00:00Z'),
        suggestedTime: '09:00',
      },
    ]);

    const updateAppointments = vi.fn().mockResolvedValue({ count: 1 });
    const createTimeline = vi.fn().mockResolvedValue({ count: 1 });
    const deactivateTherapies = vi.fn().mockResolvedValue({ count: 1 });
    const cancelReservations = vi.fn().mockResolvedValue({ count: 1 });

    mockedPrisma.$transaction.mockImplementationOnce(async (arg: any) => {
      if (typeof arg === 'function') {
        return arg({
          appointment: { updateMany: updateAppointments },
          teaPreReservationTimeline: { createMany: createTimeline },
          teaPitTherapy: { updateMany: deactivateTherapies },
          teaPreReservation: { updateMany: cancelReservations },
        });
      }
      return undefined;
    });

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/cancel-therapy-series',
      payload: {
        teaProfileId: 'tp-1',
        pitTherapyId: 'pit-1',
        cancelAll: false,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(cancelReservations).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        notes: 'Terapia removida do PIT por desmarcação em lote',
      }),
    }));
    await app.close();
  });

  it('cancels therapy series using weekday filter without deactivating therapies', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([
      {
        id: 'pr-weekday',
        patientId: 'p-1',
        pitTherapyId: 'pit-1',
        suggestedDate: new Date('2026-04-14T12:00:00Z'),
        suggestedTime: '09:00',
      },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/cancel-therapy-series',
      payload: {
        teaProfileId: 'tp-1',
        cancelAll: true,
        weekdayIndex: 2,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().affectedReservations).toBe(1);
    expect(res.json().deactivatedTherapies).toBe(0);
    await app.close();
  });

  it('returns 404 for conversion-checklist when reservation does not exist', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findFirst.mockResolvedValueOnce(null);

    const res = await app.inject({ method: 'GET', url: '/tpr/pr-x/conversion-checklist' });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns valid conversion checklist when reservation is convertible', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/tpr/pr-1/conversion-checklist' });

    expect(res.statusCode).toBe(200);
    expect(res.json().canConvert).toBe(true);
    await app.close();
  });

  it('returns conversion checklist with conflict flags', async () => {
    const app = await buildApp();
    mockedPrisma.appointment.findFirst
      .mockResolvedValueOnce({ id: 'a-1' })
      .mockResolvedValueOnce(null);

    const res = await app.inject({ method: 'GET', url: '/tpr/pr-1/conversion-checklist' });

    expect(res.statusCode).toBe(200);
    expect(res.json().canConvert).toBe(false);
    await app.close();
  });

  it('returns conversion checklist with patient conflict only', async () => {
    const app = await buildApp();
    mockedPrisma.appointment.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'a-patient' });

    const res = await app.inject({ method: 'GET', url: '/tpr/pr-1/conversion-checklist' });

    expect(res.statusCode).toBe(200);
    expect(res.json().canConvert).toBe(false);
    await app.close();
  });

  it('returns checklist as not-convertible when already converted, missing datetime, and expired', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findFirst.mockResolvedValueOnce({
      id: 'pr-1',
      patient: { id: 'p-1', name: 'Maria' },
      status: 'CONVERTED',
      suggestedDate: null,
      suggestedTime: null,
      expiresAt: new Date('2020-01-01T00:00:00Z'),
    });

    const res = await app.inject({ method: 'GET', url: '/tpr/pr-1/conversion-checklist' });

    expect(res.statusCode).toBe(200);
    expect(res.json().canConvert).toBe(false);
    expect(Array.isArray(res.json().checks)).toBe(true);
    await app.close();
  });

  it('returns 404 for timeline when reservation does not exist', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findFirst.mockResolvedValueOnce(null);

    const res = await app.inject({ method: 'GET', url: '/tpr/pr-x/timeline' });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns timeline events for existing reservation', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservationTimeline.findMany.mockResolvedValueOnce([{ id: 'tl-1' }]);

    const res = await app.inject({ method: 'GET', url: '/tpr/pr-1/timeline' });

    expect(res.statusCode).toBe(200);
    expect(res.json().events).toHaveLength(1);
    await app.close();
  });

  it('returns 404 when converting unknown pre-reservation', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findFirst.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/pr-x/convert-to-appointment',
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 400 when pre-reservation is already converted', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findFirst.mockResolvedValueOnce({
      id: 'pr-1',
      patient: { id: 'p-1' },
      status: 'CONVERTED',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/pr-1/convert-to-appointment',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 when converting single reservation not in AUTHORIZED status', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findFirst.mockResolvedValueOnce({
      id: 'pr-1',
      patient: { id: 'p-1', name: 'Maria', cpf: '11144477735', healthInsuranceName: 'Plano X' },
      status: 'RESERVED',
      suggestedDate: new Date('2026-04-14T00:00:00Z'),
      suggestedTime: '09:00',
      professionalName: 'Dra. Ana',
      procedureName: 'TO',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/pr-1/convert-to-appointment',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 409 when single conversion has schedule conflict', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findFirst.mockResolvedValueOnce({
      id: 'pr-1',
      pitId: 'pit-main',
      pitTherapyId: 'pit-1',
      patient: { id: 'p-1', name: 'Maria', cpf: '11144477735', healthInsuranceName: 'Plano X', branchId: 'b-1' },
      status: 'AUTHORIZED',
      suggestedDate: new Date('2026-04-14T00:00:00Z'),
      suggestedTime: '09:00',
      professionalName: 'Dra. Ana',
      procedureName: 'TO',
      durationMinutes: 45,
      expiresAt: null,
    });
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([{ id: 'a-1', time: '09:00', durationMinutes: 45 }]);

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/pr-1/convert-to-appointment',
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('returns 409 when single conversion has patient-only conflict', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findFirst.mockResolvedValueOnce({
      id: 'pr-1',
      pitId: 'pit-main',
      pitTherapyId: 'pit-1',
      patient: { id: 'p-1', name: 'Maria', cpf: '11144477735', healthInsuranceName: 'Plano X', branchId: 'b-1' },
      status: 'AUTHORIZED',
      suggestedDate: new Date('2026-04-14T00:00:00Z'),
      suggestedTime: '09:00',
      professionalName: 'Dra. Ana',
      procedureName: 'TO',
      durationMinutes: 45,
      expiresAt: null,
    });
    mockedPrisma.appointment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'a-patient', time: '09:00', durationMinutes: 45 }]);

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/pr-1/convert-to-appointment',
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('returns 400 when single conversion has no suggested date/time', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findFirst.mockResolvedValueOnce({
      id: 'pr-1',
      patient: { id: 'p-1', name: 'Maria', cpf: '11144477735', healthInsuranceName: 'Plano X' },
      status: 'AUTHORIZED',
      suggestedDate: null,
      suggestedTime: null,
      professionalName: 'Dra. Ana',
      procedureName: 'TO',
      durationMinutes: 45,
      expiresAt: null,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/pr-1/convert-to-appointment',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 when single conversion is expired', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findFirst.mockResolvedValueOnce({
      id: 'pr-1',
      patient: { id: 'p-1', name: 'Maria', cpf: '11144477735', healthInsuranceName: 'Plano X' },
      status: 'AUTHORIZED',
      suggestedDate: new Date('2026-04-14T00:00:00Z'),
      suggestedTime: '09:00',
      professionalName: 'Dra. Ana',
      procedureName: 'TO',
      durationMinutes: 45,
      expiresAt: new Date('2020-01-01T00:00:00Z'),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/pr-1/convert-to-appointment',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('converts single reservation to appointment successfully', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findFirst.mockResolvedValueOnce({
      id: 'pr-1',
      pitId: 'pit-main',
      pitTherapyId: 'pit-1',
      patient: { id: 'p-1', name: 'Maria', cpf: '11144477735', healthInsuranceName: 'Plano X', branchId: 'b-1' },
      status: 'AUTHORIZED',
      suggestedDate: new Date('2026-04-14T00:00:00Z'),
      suggestedTime: '09:00',
      professionalName: 'Dra. Ana',
      procedureName: 'TO',
      durationMinutes: 45,
      expiresAt: null,
    });
    mockedPrisma.appointment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockedPrisma.$transaction.mockImplementationOnce(async (arg: any) => {
      if (typeof arg === 'function') {
        return arg({
          appointment: { create: vi.fn().mockResolvedValue({ id: 'a-2' }) },
          teaPreReservation: { update: vi.fn().mockResolvedValue({ id: 'pr-1', status: 'CONVERTED' }) },
        });
      }
      return undefined;
    });

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/pr-1/convert-to-appointment',
      payload: { observation: 'ok' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().appointment.id).toBe('a-2');
    await app.close();
  });

  it('lists pre-reservations without loading attachments when no pitTherapyId exists', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'pr-1',
          pitTherapyId: null,
          patient: { id: 'p-1', name: 'Maria', cpf: '11144477735', birthDate: new Date('1990-01-01T00:00:00Z') },
        },
      ]);
    mockedPrisma.teaPreReservation.count.mockResolvedValueOnce(1);

    const res = await app.inject({ method: 'GET', url: '/tpr?status=AUTHORIZED&limit=10&offset=0' });

    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].authorizationAttachmentsCount).toBe(0);
    expect(mockedPrisma.convenioAuthorizationAttachment.findMany).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 400 when converting series without convertible reservations', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/pr-1/convert-to-appointment',
      payload: { convertSeries: true },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('converts series and skips invalid or expired reservations', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([
      {
        id: 'pr-invalid',
        patient: { id: 'p-1', name: 'Maria', cpf: '11144477735', healthInsuranceName: 'Plano X' },
        status: 'AUTHORIZED',
        suggestedDate: null,
        suggestedTime: '09:00',
        professionalName: 'Dra. Ana',
        procedureName: 'TO',
        durationMinutes: 45,
      },
      {
        id: 'pr-expired',
        patient: { id: 'p-1', name: 'Maria', cpf: '11144477735', healthInsuranceName: 'Plano X' },
        status: 'AUTHORIZED',
        suggestedDate: new Date('2026-04-14T00:00:00Z'),
        suggestedTime: '10:00',
        professionalName: 'Dra. Ana',
        procedureName: 'TO',
        durationMinutes: 45,
        expiresAt: new Date('2020-01-01T00:00:00Z'),
      },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/pr-1/convert-to-appointment',
      payload: { convertSeries: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().convertedCount).toBe(0);
    expect(res.json().skippedInvalid).toBe(2);
    await app.close();
  });

  it('converts series and skips doctor-conflict items', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([
      {
        id: 'pr-1',
        patient: { id: 'p-1', name: 'Maria', cpf: '11144477735', healthInsuranceName: 'Plano X' },
        status: 'AUTHORIZED',
        suggestedDate: new Date('2026-04-14T00:00:00Z'),
        suggestedTime: '09:00',
        professionalName: 'Dra. Ana',
        procedureName: 'TO',
        durationMinutes: 45,
      },
    ]);
    mockedPrisma.appointment.findMany
      .mockResolvedValueOnce([{ id: 'a-doctor', time: '09:00', durationMinutes: 45 }])
      .mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/pr-1/convert-to-appointment',
      payload: { convertSeries: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().convertedCount).toBe(0);
    expect(res.json().skippedConflicts).toBe(1);
    await app.close();
  });

  it('converts series and reuses existing patient appointment when conflict is patient-only', async () => {
    const app = await buildApp();
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([
      {
        id: 'pr-1',
        patient: { id: 'p-1', name: 'Maria', cpf: '11144477735', healthInsuranceName: 'Plano X' },
        status: 'AUTHORIZED',
        suggestedDate: new Date('2026-04-14T00:00:00Z'),
        suggestedTime: '09:00',
        professionalName: 'Dra. Ana',
        procedureName: 'TO',
        durationMinutes: 45,
      },
    ]);
    mockedPrisma.appointment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'a-patient', time: '09:00', durationMinutes: 45 }]);
    mockedPrisma.teaPreReservation.update.mockResolvedValueOnce({ id: 'pr-1', status: 'CONVERTED' });

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/pr-1/convert-to-appointment',
      payload: { convertSeries: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().convertedCount).toBe(1);
    expect(res.json().items[0].reusedExistingAppointment).toBe(true);
    await app.close();
  });

  it('converts series with date override and merges 15-minute chunks into anchor slot', async () => {
    const app = await buildApp();
    mockedPrisma.teaPitTherapy.findFirst.mockResolvedValueOnce({
      id: 'pit-1',
      preferredWeekdays: ['SEGUNDA'],
    });
    mockedPrisma.teaPreReservation.findMany.mockResolvedValueOnce([
      {
        id: 'pr-anchor',
        patient: { id: 'p-1', name: 'Maria', cpf: '11144477735', healthInsuranceName: 'Plano X' },
        status: 'AUTHORIZED',
        suggestedDate: new Date('2026-04-14T00:00:00Z'),
        suggestedTime: '09:00',
        professionalName: 'Dra. Ana',
        procedureName: 'TO',
        durationMinutes: 60,
      },
      {
        id: 'pr-chunk',
        patient: { id: 'p-1', name: 'Maria', cpf: '11144477735', healthInsuranceName: 'Plano X' },
        status: 'AUTHORIZED',
        suggestedDate: new Date('2026-04-14T00:00:00Z'),
        suggestedTime: '09:15',
        professionalName: 'Dra. Ana',
        procedureName: 'TO',
        durationMinutes: 15,
      },
    ]);
    mockedPrisma.appointment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockedPrisma.$transaction.mockImplementationOnce(async (arg: any) => {
      if (typeof arg === 'function') {
        return arg({
          appointment: { create: vi.fn().mockResolvedValue({ id: 'a-series' }) },
          teaPreReservation: { update: vi.fn().mockResolvedValue({ id: 'pr-anchor', status: 'CONVERTED' }) },
        });
      }
      return undefined;
    });
    mockedPrisma.teaPreReservation.updateMany.mockResolvedValueOnce({ count: 1 });

    const res = await app.inject({
      method: 'POST',
      url: '/tpr/pr-1/convert-to-appointment',
      payload: { convertSeries: true, seriesStartDate: '2026-04-13' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().convertedCount).toBe(1);
    expect(res.json().mergedChunks).toBe(1);
    expect(mockedPrisma.teaPreReservation.updateMany).toHaveBeenCalled();
    await app.close();
  });
});
