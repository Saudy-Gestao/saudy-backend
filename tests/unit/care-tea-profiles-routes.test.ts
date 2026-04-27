import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import teaProfilesRoutes, { __teaProfilesTestables } from '../../src/modules/care/routes/tea-profiles';
import prisma from '../../src/modules/care/lib/prisma';
import { isValidCpf, normalizeCpf } from '../../src/lib/cpf';
import { isValidEmail, normalizeEmail } from '../../src/lib/email';

vi.mock('../../src/lib/cpf', () => ({
  isValidCpf: vi.fn(),
  normalizeCpf: vi.fn(),
}));

vi.mock('../../src/lib/email', () => ({
  isValidEmail: vi.fn(),
  normalizeEmail: vi.fn(),
}));

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    patient: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    teaProfile: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), upsert: vi.fn() },
    procedure: { findFirst: vi.fn() },
    doctor: { findFirst: vi.fn() },
    appointment: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    teaTherapeuticPlan: { findMany: vi.fn(), create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), count: vi.fn() },
    teaEvolution: { findMany: vi.fn(), create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), count: vi.fn(), aggregate: vi.fn() },
    teaPit: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    teaPitTherapy: { updateMany: vi.fn() },
    teaPreReservation: { findMany: vi.fn(), updateMany: vi.fn() },
    teaPreReservationTimeline: { createMany: vi.fn() },
    convenioAuthorizationAttachment: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const mockedPrisma = prisma as any;
const mockedIsValidCpf = isValidCpf as any;
const mockedNormalizeCpf = normalizeCpf as any;
const mockedIsValidEmail = isValidEmail as any;
const mockedNormalizeEmail = normalizeEmail as any;

async function buildApp(opts?: { unauthorized?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1' };
  });
  await app.register(teaProfilesRoutes, { prefix: '/tea-profiles' });
  return app;
}

describe('care tea-profiles helpers', () => {
  it('normalizes genders, shifts and signatures', () => {
    expect(__teaProfilesTestables.toGender(undefined)).toBeUndefined();
    expect(__teaProfilesTestables.toGender('M')).toBe('MALE');
    expect(__teaProfilesTestables.toGender('feminino')).toBe('FEMALE');
    expect(__teaProfilesTestables.toGender('other')).toBe('OTHER');
    expect(__teaProfilesTestables.toGender('x')).toBeUndefined();

    expect(__teaProfilesTestables.normalizePreferredShift(undefined)).toBeUndefined();
    expect(__teaProfilesTestables.normalizePreferredShift('manhã, tarde, noite, manhã')).toBe('MANHA,TARDE,NOITE');
    expect(__teaProfilesTestables.normalizePreferredShift('invalido')).toBeUndefined();

    expect(__teaProfilesTestables.normalizeWeekdays([' quarta ', 'SEGUNDA', ''])).toEqual(['QUARTA', 'SEGUNDA']);
    expect(__teaProfilesTestables.normalizeWeekdays('x')).toEqual([]);

    const signature = __teaProfilesTestables.buildTherapySignature({
      procedureId: 'proc-1',
      therapyType: 'TO',
      professionalDoctorId: 'doc-1',
      preferredShift: 'MANHA',
      weeklyFrequency: 2,
      preferredWeekdays: ['SEGUNDA', 'QUARTA'],
    });
    expect(signature).toContain('proc-1');
    expect(signature).toContain('to');
    expect(signature).toContain('doc-1');
  });

  it('resolves actor, strategies and appointment cancellations', async () => {
    expect(__teaProfilesTestables.resolveActorFromRequest({ user: { name: 'Maria', email: 'm@test.com', id: 'u-1' } })).toBe('Maria');
    expect(__teaProfilesTestables.resolveActorFromRequest({ user: { email: 'm@test.com', id: 'u-1' } })).toBe('m@test.com');
    expect(__teaProfilesTestables.resolveActorFromRequest({ user: { id: 'u-1' } })).toBe('u-1');
    expect(__teaProfilesTestables.resolveActorFromRequest({ user: {} })).toBe('SYSTEM');

    expect(__teaProfilesTestables.normalizeStrategies(['  A  ', '', null])).toEqual(['A']);
    expect(__teaProfilesTestables.normalizeStrategies('x')).toEqual([]);

    const tx: any = {
      appointment: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'a-1', patientId: 'p-1', doctorName: 'Dr A', date: '2026-04-20', time: '09:00', observations: 'contains pr-1' },
          { id: 'a-2', patientId: 'p-1', doctorName: 'Dr B', date: '2026-04-20', time: '10:00', observations: '' },
          { id: 'a-3', patientId: 'p-1', doctorName: 'Dr C', date: '2026-04-20', time: '11:00', observations: '' },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };

    const reservations = [
      { id: 'pr-1', patientId: 'p-1', suggestedDate: new Date('2026-04-20T00:00:00Z'), suggestedTime: '09:00', professionalName: 'Dr A' },
      { id: 'pr-2', patientId: 'p-1', suggestedDate: new Date('2026-04-20T00:00:00Z'), suggestedTime: '10:00', professionalName: 'Dr B' },
    ];

    const ids = await __teaProfilesTestables.resolveAppointmentIdsForConvertedReservations(tx, reservations);
    expect(ids).toEqual(expect.arrayContaining(['a-1']));

    const cancelled = await __teaProfilesTestables.cancelAppointmentsForConvertedReservations(tx, reservations, 'reason');
    expect(cancelled).toBe(2);

    const noCancellation = await __teaProfilesTestables.cancelAppointmentsForConvertedReservations({
      appointment: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    }, [], 'reason');
    expect(noCancellation).toBe(0);
  });
});

describe('care tea-profiles routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedNormalizeCpf.mockImplementation((v: string) => String(v || '').replace(/\D/g, ''));
    mockedIsValidCpf.mockReturnValue(true);
    mockedNormalizeEmail.mockImplementation((v: string) => String(v || '').trim().toLowerCase() || '');
    mockedIsValidEmail.mockReturnValue(true);

    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b-1' } } });
    mockedPrisma.teaProfile.findMany.mockResolvedValue([{ id: 't-1' }]);
    mockedPrisma.teaProfile.count.mockResolvedValue(1);
    mockedPrisma.teaProfile.findFirst.mockResolvedValue(null);
    mockedPrisma.patient.findFirst.mockResolvedValue(null);
    mockedPrisma.patient.create.mockResolvedValue({ id: 'p-1' });
    mockedPrisma.patient.update.mockResolvedValue({ id: 'p-1' });
    mockedPrisma.teaProfile.upsert.mockResolvedValue({ id: 't-1' });
    mockedPrisma.procedure.findFirst.mockResolvedValue({ id: 'proc-1', name: 'TO' });
    mockedPrisma.doctor.findFirst.mockResolvedValue({ id: 'd-1', name: 'Dr A' });
    mockedPrisma.appointment.findFirst.mockResolvedValue({ id: 'a-1' });
    mockedPrisma.appointment.findMany.mockResolvedValue([]);
    mockedPrisma.appointment.updateMany.mockResolvedValue({ count: 0 });
    mockedPrisma.teaTherapeuticPlan.findMany.mockResolvedValue([]);
    mockedPrisma.teaTherapeuticPlan.create.mockResolvedValue({ id: 'plan-1' });
    mockedPrisma.teaTherapeuticPlan.findFirst.mockResolvedValue(null);
    mockedPrisma.teaTherapeuticPlan.update.mockResolvedValue({ id: 'plan-1' });
    mockedPrisma.teaTherapeuticPlan.count.mockResolvedValue(0);
    mockedPrisma.teaEvolution.findMany.mockResolvedValue([]);
    mockedPrisma.teaEvolution.create.mockResolvedValue({ id: 'ev-1' });
    mockedPrisma.teaEvolution.findFirst.mockResolvedValue(null);
    mockedPrisma.teaEvolution.update.mockResolvedValue({ id: 'ev-1' });
    mockedPrisma.teaEvolution.count.mockResolvedValue(0);
    mockedPrisma.teaEvolution.aggregate.mockResolvedValue({ _avg: { progressScore: null } });
    mockedPrisma.teaPit.findFirst.mockResolvedValue(null);
    mockedPrisma.teaPit.create.mockResolvedValue({ id: 'pit-1', therapies: [] });
    mockedPrisma.teaPit.update.mockResolvedValue({ id: 'pit-1' });
    mockedPrisma.teaPit.findUnique.mockResolvedValue({ id: 'pit-1', therapies: [] });
    mockedPrisma.teaPitTherapy.updateMany.mockResolvedValue({ count: 0 });
    mockedPrisma.teaPreReservation.findMany.mockResolvedValue([]);
    mockedPrisma.teaPreReservation.updateMany.mockResolvedValue({ count: 0 });
    mockedPrisma.teaPreReservationTimeline.createMany.mockResolvedValue({ count: 0 });
    mockedPrisma.convenioAuthorizationAttachment.updateMany.mockResolvedValue({ count: 0 });
    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb({
      teaPit: { update: vi.fn(), findUnique: vi.fn().mockResolvedValue({ id: 'pit-1', therapies: [] }) },
      teaPitTherapy: { update: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
      teaPreReservation: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn(), },
      teaPreReservationTimeline: { createMany: vi.fn() },
      appointment: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      convenioAuthorizationAttachment: { updateMany: vi.fn() },
    }));
  });

  it('handles auth hook, list and get', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/tea-profiles' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    const app = await buildApp();
    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/tea-profiles' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/tea-profiles?search=maria&hasActivePit=true' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    res = await app.inject({ method: 'GET', url: '/tea-profiles/t-1' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1' });
    res = await app.inject({ method: 'GET', url: '/tea-profiles/t-1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('upsert validates and handles patient creation flow', async () => {
    const app = await buildApp();

    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockedIsValidCpf.mockReturnValueOnce(false);
    let res = await app.inject({
      method: 'POST',
      url: '/tea-profiles/upsert',
      payload: { patient: { name: '', cpf: '123', birthDate: 'invalid', gender: '', cellphone: '' } },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    res = await app.inject({
      method: 'POST',
      url: '/tea-profiles/upsert',
      payload: {
        patient: {
          name: 'Maria',
          cpf: '12345678901',
          birthDate: '2010-01-01',
          gender: 'F',
          cellphone: '1199999',
          email: 'maria@test.com',
        },
        tea: { supportLevel: '2' },
      },
    });
    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it('upsert handles patientId branch and invalid email update', async () => {
    const app = await buildApp();

    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({
      method: 'POST',
      url: '/tea-profiles/upsert',
      payload: { patientId: 'p-x' },
    });
    expect(res.statusCode).toBe(404);

    mockedPrisma.patient.findFirst.mockResolvedValueOnce({ id: 'p-1' });
    mockedIsValidEmail.mockReturnValueOnce(false);
    res = await app.inject({
      method: 'POST',
      url: '/tea-profiles/upsert',
      payload: { patientId: 'p-1', patient: { email: 'bad' } },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.patient.findFirst.mockResolvedValueOnce({ id: 'p-1' });
    res = await app.inject({
      method: 'POST',
      url: '/tea-profiles/upsert',
      payload: { patientId: 'p-1', patient: { email: 'ok@test.com' }, tea: { isActive: true } },
    });
    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it('handles plans crud flow', async () => {
    const app = await buildApp();

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'GET', url: '/tea-profiles/t-1/plans' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1' });
    mockedPrisma.teaTherapeuticPlan.findMany.mockResolvedValueOnce([{ id: 'plan-1' }]);
    res = await app.inject({ method: 'GET', url: '/tea-profiles/t-1/plans?search=abc&isActive=true' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1' });
    res = await app.inject({ method: 'POST', url: '/tea-profiles/t-1/plans', payload: {} });
    expect(res.statusCode).toBe(400);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1' });
    mockedPrisma.doctor.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({
      method: 'POST',
      url: '/tea-profiles/t-1/plans',
      payload: { title: 'Plano', responsibleDoctorId: 'd-x' },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1' });
    mockedPrisma.doctor.findFirst.mockResolvedValueOnce({ id: 'd-1', name: 'Dr A' });
    res = await app.inject({
      method: 'POST',
      url: '/tea-profiles/t-1/plans',
      payload: { title: 'Plano', responsibleDoctorId: 'd-1' },
    });
    expect(res.statusCode).toBe(201);

    mockedPrisma.teaTherapeuticPlan.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'PUT', url: '/tea-profiles/plans/plan-x', payload: {} });
    expect(res.statusCode).toBe(404);

    mockedPrisma.teaTherapeuticPlan.findFirst.mockResolvedValueOnce({ id: 'plan-1' });
    mockedPrisma.doctor.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'PUT', url: '/tea-profiles/plans/plan-1', payload: { responsibleDoctorId: 'd-x' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.teaTherapeuticPlan.findFirst.mockResolvedValueOnce({ id: 'plan-1' });
    mockedPrisma.doctor.findFirst.mockResolvedValueOnce({ id: 'd-1', name: 'Dr A' });
    res = await app.inject({ method: 'PUT', url: '/tea-profiles/plans/plan-1', payload: { responsibleDoctorId: 'd-1' } });
    expect(res.statusCode).toBe(200);

    mockedPrisma.teaTherapeuticPlan.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'DELETE', url: '/tea-profiles/plans/plan-x' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.teaTherapeuticPlan.findFirst.mockResolvedValueOnce({ id: 'plan-1' });
    res = await app.inject({ method: 'DELETE', url: '/tea-profiles/plans/plan-1' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('handles evolutions and reports', async () => {
    const app = await buildApp();

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'GET', url: '/tea-profiles/t-1/evolutions' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1' });
    mockedPrisma.teaEvolution.findMany.mockResolvedValueOnce([{ id: 'ev-1' }]);
    res = await app.inject({ method: 'GET', url: '/tea-profiles/t-1/evolutions' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1', patientId: 'p-1' });
    res = await app.inject({ method: 'POST', url: '/tea-profiles/t-1/evolutions', payload: {} });
    expect(res.statusCode).toBe(400);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1', patientId: 'p-1' });
    res = await app.inject({
      method: 'POST',
      url: '/tea-profiles/t-1/evolutions',
      payload: { sessionGoal: 'Goal', interventionSummary: 'Done', strategiesUsed: ['A'], appointmentId: 'a-1' },
    });
    expect(res.statusCode).toBe(201);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1', patientId: 'p-1' });
    mockedPrisma.teaEvolution.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({
      method: 'PUT',
      url: '/tea-profiles/t-1/evolutions/ev-x',
      payload: { editReason: 'ret', sessionGoal: 'g', interventionSummary: 'i', strategiesUsed: ['A'] },
    });
    expect(res.statusCode).toBe(404);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1', patientId: 'p-1' });
    mockedPrisma.teaEvolution.findFirst.mockResolvedValueOnce({ id: 'ev-1', sessionDate: new Date() });
    res = await app.inject({
      method: 'PUT',
      url: '/tea-profiles/t-1/evolutions/ev-1',
      payload: { editReason: 'ret', sessionGoal: 'g', interventionSummary: 'i', strategiesUsed: ['A'] },
    });
    expect(res.statusCode).toBe(200);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1', patient: { id: 'p-1' } });
    res = await app.inject({ method: 'GET', url: '/tea-profiles/t-1/reports?startDate=bad' });
    expect(res.statusCode).toBe(400);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1', patient: { id: 'p-1', name: 'Maria' } });
    mockedPrisma.teaEvolution.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.teaPit.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/tea-profiles/t-1/reports?startDate=2026-01-01&endDate=2026-12-31' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('handles pit get delete and upsert', async () => {
    const app = await buildApp();

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'GET', url: '/tea-profiles/t-x/pit' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1' });
    mockedPrisma.teaPit.findFirst.mockResolvedValueOnce({ id: 'pit-1', therapies: [] });
    res = await app.inject({ method: 'GET', url: '/tea-profiles/t-1/pit' });
    expect(res.statusCode).toBe(200);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockedPrisma.teaPit.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'DELETE', url: '/tea-profiles/t-x/pit' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1' });
    mockedPrisma.teaPit.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'pit-1', status: 'Inativo' });
    res = await app.inject({ method: 'DELETE', url: '/tea-profiles/t-1/pit' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1' });
    res = await app.inject({ method: 'POST', url: '/tea-profiles/t-1/pit/upsert', payload: {} });
    expect(res.statusCode).toBe(400);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1' });
    mockedPrisma.teaPit.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({
      method: 'POST',
      url: '/tea-profiles/t-1/pit/upsert',
      payload: { title: 'PIT', therapies: [{ therapyType: 'TO' }] },
    });
    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it('validates pit upsert procedure/professional and existing therapy ids', async () => {
    const app = await buildApp();

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1' });
    mockedPrisma.procedure.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({
      method: 'POST',
      url: '/tea-profiles/t-1/pit/upsert',
      payload: { title: 'PIT', therapies: [{ procedureId: 'proc-x' }] },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1' });
    mockedPrisma.procedure.findFirst.mockResolvedValueOnce({ id: 'proc-1', name: 'TO' });
    mockedPrisma.doctor.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({
      method: 'POST',
      url: '/tea-profiles/t-1/pit/upsert',
      payload: { title: 'PIT', therapies: [{ procedureId: 'proc-1', professionalDoctorId: 'd-x' }] },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1' });
    mockedPrisma.teaPit.findFirst.mockResolvedValueOnce({
      id: 'pit-1',
      therapies: [{ id: 'th-1', isActive: true, therapyType: 'TO', weeklyFrequency: 1, preferredWeekdays: ['SEGUNDA'] }],
    });
    res = await app.inject({
      method: 'POST',
      url: '/tea-profiles/t-1/pit/upsert',
      payload: { title: 'PIT', therapies: [{ id: 'th-999', therapyType: 'TO' }] },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('updates existing pit with valid therapies', async () => {
    const app = await buildApp();

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1' });
    mockedPrisma.teaPit.findFirst.mockResolvedValueOnce({
      id: 'pit-1',
      therapies: [{
        id: 'th-1',
        isActive: true,
        procedureId: null,
        therapyType: 'TO',
        weeklyFrequency: 1,
        preferredWeekdays: ['SEGUNDA'],
        preferredShift: null,
        durationMinutes: null,
        professionalDoctorId: null,
        professional: null,
      }],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/tea-profiles/t-1/pit/upsert',
      payload: {
        title: 'PIT Atualizado',
        therapies: [{ id: 'th-1', therapyType: 'TO', weeklyFrequency: 2, preferredWeekdays: ['SEGUNDA', 'QUARTA'] }],
      },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('returns 400 when a therapy resolves to invalid payload (missing type and procedure)', async () => {
    const app = await buildApp();

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1' });
    const res = await app.inject({
      method: 'POST',
      url: '/tea-profiles/t-1/pit/upsert',
      payload: {
        title: 'PIT',
        therapies: [{ therapyType: '   ' }],
      },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('reconciles therapies by signature, reactivates changed inactive therapy and cancels future sessions for removed therapy', async () => {
    const app = await buildApp();

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1' });
    mockedPrisma.teaPit.findFirst.mockResolvedValueOnce({
      id: 'pit-1',
      therapies: [
        {
          id: 'th-inactive',
          isActive: false,
          procedureId: null,
          therapyType: 'TO',
          weeklyFrequency: 1,
          preferredWeekdays: ['SEGUNDA'],
          preferredShift: 'MANHA',
          durationMinutes: 45,
          professionalDoctorId: null,
          professional: 'Dr A',
        },
        {
          id: 'th-removed',
          isActive: true,
          procedureId: null,
          therapyType: 'FONO',
          weeklyFrequency: 1,
          preferredWeekdays: ['TERCA'],
          preferredShift: 'TARDE',
          durationMinutes: 45,
          professionalDoctorId: null,
          professional: 'Dr B',
        },
      ],
    });

    const txTeaPitTherapyUpdate = vi.fn().mockResolvedValue({ id: 'th-inactive' });
    const txTeaPitTherapyUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const txTeaPreReservationFindMany = vi.fn()
      .mockResolvedValueOnce([{ id: 'pr-open' }])
      .mockResolvedValueOnce([
        {
          id: 'pr-conv-1',
          patientId: 'p-1',
          suggestedDate: new Date('2026-04-20T00:00:00Z'),
          suggestedTime: '09:00',
          professionalName: 'Dr B',
        },
      ]);
    const txTeaPreReservationUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const txTimelineCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    const txAppointmentFindMany = vi.fn().mockResolvedValue([]);
    const txAppointmentUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const txAttachmentUpdateMany = vi.fn().mockResolvedValue({ count: 0 });

    mockedPrisma.$transaction.mockImplementationOnce(async (cb: any) => cb({
      teaPit: {
        update: vi.fn().mockResolvedValue({ id: 'pit-1' }),
        findUnique: vi.fn().mockResolvedValue({ id: 'pit-1', therapies: [] }),
      },
      teaPitTherapy: {
        update: txTeaPitTherapyUpdate,
        create: vi.fn(),
        updateMany: txTeaPitTherapyUpdateMany,
      },
      teaPreReservation: {
        findMany: txTeaPreReservationFindMany,
        updateMany: txTeaPreReservationUpdateMany,
      },
      teaPreReservationTimeline: { createMany: txTimelineCreateMany },
      appointment: { findMany: txAppointmentFindMany, updateMany: txAppointmentUpdateMany },
      convenioAuthorizationAttachment: { updateMany: txAttachmentUpdateMany },
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/tea-profiles/t-1/pit/upsert',
      payload: {
        title: 'PIT Atualizado',
        removedTherapies: [{ id: 'th-removed', action: 'CANCEL_FUTURE_APPOINTMENTS' }],
        therapies: [
          {
            id: 'th-inactive',
            therapyType: 'TO',
            weeklyFrequency: 2,
            preferredWeekdays: ['SEGUNDA'],
            preferredShift: 'MANHA',
            durationMinutes: 45,
            professional: 'Dr A',
          },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(txTeaPitTherapyUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'th-inactive' },
      data: expect.objectContaining({ isActive: true }),
    }));
    expect(txTeaPitTherapyUpdateMany).toHaveBeenCalled();
    expect(txTeaPreReservationUpdateMany).toHaveBeenCalled();
    expect(txTimelineCreateMany).toHaveBeenCalled();
    expect(txAppointmentFindMany).toHaveBeenCalled();
    await app.close();
  });

  it('covers additional plans and evolutions validation branches', async () => {
    const app = await buildApp();

    mockedPrisma.teaTherapeuticPlan.findFirst.mockResolvedValueOnce({ id: 'plan-1' });
    let res = await app.inject({ method: 'PUT', url: '/tea-profiles/plans/plan-1', payload: { responsibleDoctorId: null } });
    expect(res.statusCode).toBe(200);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1', patientId: 'p-1' });
    mockedPrisma.teaTherapeuticPlan.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({
      method: 'POST',
      url: '/tea-profiles/t-1/evolutions',
      payload: { therapeuticPlanId: 'plan-x', sessionGoal: 'g', interventionSummary: 'i', strategiesUsed: ['A'] },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1', patientId: 'p-1' });
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'POST', url: '/tea-profiles/t-1/evolutions', payload: { sessionGoal: 'g', interventionSummary: 'i', strategiesUsed: ['A'], appointmentId: 'a-1' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({ id: 'a-1' });
    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1', patientId: 'p-1' });
    mockedPrisma.doctor.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({
      method: 'POST',
      url: '/tea-profiles/t-1/evolutions',
      payload: {
        sessionGoal: 'g',
        interventionSummary: 'i',
        strategiesUsed: ['A'],
        appointmentId: 'a-1',
        professionalDoctorId: 'd-x',
      },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1', patientId: 'p-1' });
    mockedPrisma.teaEvolution.findFirst.mockResolvedValueOnce({ id: 'ev-1', sessionDate: new Date() });
    res = await app.inject({ method: 'PUT', url: '/tea-profiles/t-1/evolutions/ev-1', payload: { sessionGoal: 'g', interventionSummary: 'i', strategiesUsed: ['A'] } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1', patientId: 'p-1' });
    mockedPrisma.teaEvolution.findFirst.mockResolvedValueOnce({ id: 'ev-1', sessionDate: new Date() });
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({ id: 'a-1' });
    mockedPrisma.teaTherapeuticPlan.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({
      method: 'PUT',
      url: '/tea-profiles/t-1/evolutions/ev-1',
      payload: {
        editReason: 'ret',
        sessionGoal: 'g',
        interventionSummary: 'i',
        strategiesUsed: ['A'],
        appointmentId: 'a-1',
        therapeuticPlanId: 'plan-x',
      },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('covers reports and pit-delete alternative flows', async () => {
    const app = await buildApp();

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'GET', url: '/tea-profiles/t-x/reports' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1', patient: { id: 'p-1', name: 'Maria' } });
    mockedPrisma.teaEvolution.findFirst.mockResolvedValueOnce({ id: 'ev-1' });
    mockedPrisma.teaPit.findFirst.mockResolvedValueOnce({
      id: 'pit-1',
      title: 'PIT',
      status: 'Ativo',
      startDate: new Date('2026-01-01T00:00:00Z'),
      reviewDate: null,
      therapies: [{ id: 'th-1' }],
    });
    res = await app.inject({ method: 'GET', url: '/tea-profiles/t-1/reports?startDate=2026-01-01&endDate=2026-12-31' });
    expect(res.statusCode).toBe(200);
    expect(res.json().pit).not.toBeNull();

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.teaPit.findFirst
      .mockResolvedValueOnce({ id: 'pit-9', teaProfileId: 't-1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'pit-9', status: 'Inativo' });
    res = await app.inject({ method: 'DELETE', url: '/tea-profiles/pit-9/pit' });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toContain('inativo');

    await app.close();
  });

  it('covers pit upsert with non-array therapies and ignored removedTherapies ids', async () => {
    const app = await buildApp();

    mockedPrisma.teaProfile.findFirst.mockResolvedValueOnce({ id: 't-1' });
    mockedPrisma.teaPit.findFirst.mockResolvedValueOnce({ id: 'pit-1', therapies: [] });
    const res = await app.inject({
      method: 'POST',
      url: '/tea-profiles/t-1/pit/upsert',
      payload: {
        title: 'PIT sem terapias',
        removedTherapies: [{ id: '   ' }],
      },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });
});
