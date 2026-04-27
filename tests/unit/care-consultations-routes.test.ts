import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import consultationRoutes from '../../src/modules/care/routes/consultations';
import prisma from '../../src/modules/care/lib/prisma';

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    procedure: { findMany: vi.fn() },
    appointment: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    consultation: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    consultationNursingResponse: {
      delete: vi.fn(),
      create: vi.fn(),
    },
    consultationNursingAnswer: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    invoice: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    branchSettings: { findUnique: vi.fn() },
    patient: { findFirst: vi.fn() },
    doctor: { findFirst: vi.fn() },
    preSchedulingFlow: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const mockedPrisma = prisma as any;

const tx = {
  consultationNursingAnswer: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
  consultationNursingResponse: {
    delete: vi.fn(),
    create: vi.fn(),
  },
  consultation: {
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

  await app.register(consultationRoutes, { prefix: '/consultations' });
  return app;
}

describe('care consultations routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mockedPrisma.user.findUnique.mockResolvedValue({
      sector: { branch: { id: 'b-1' } },
      doctor: { id: 'd-1', name: 'Dr A' },
    });
    mockedPrisma.procedure.findMany.mockResolvedValue([]);
    mockedPrisma.appointment.findFirst.mockResolvedValue(null);
    mockedPrisma.appointment.findMany.mockResolvedValue([]);
    mockedPrisma.appointment.update.mockResolvedValue({ id: 'a-1' });

    mockedPrisma.consultation.findMany.mockResolvedValue([{ id: 'c-1', appointment: null, nursingResponse: null }]);
    mockedPrisma.consultation.count.mockResolvedValue(1);
    mockedPrisma.consultation.findFirst.mockResolvedValue(null);
    mockedPrisma.consultation.create.mockResolvedValue({ id: 'c-1', queue: 'Aguardando atendimento' });
    mockedPrisma.consultation.update.mockResolvedValue({ id: 'c-1', queue: 'Em atendimento' });
    mockedPrisma.consultation.delete.mockResolvedValue({ id: 'c-1' });

    mockedPrisma.invoice.findUnique.mockResolvedValue(null);
    mockedPrisma.invoice.create.mockResolvedValue({ id: 'inv-1' });
    mockedPrisma.invoice.update.mockResolvedValue({ id: 'inv-1' });
    mockedPrisma.branchSettings.findUnique.mockResolvedValue({});
    mockedPrisma.patient.findFirst.mockResolvedValue(null);
    mockedPrisma.doctor.findFirst.mockResolvedValue(null);
    mockedPrisma.preSchedulingFlow.findUnique.mockResolvedValue(null);

    tx.consultationNursingAnswer.deleteMany.mockResolvedValue({ count: 0 });
    tx.consultationNursingAnswer.createMany.mockResolvedValue({ count: 1 });
    tx.consultationNursingResponse.delete.mockResolvedValue({ id: 'nr-old' });
    tx.consultationNursingResponse.create.mockResolvedValue({ id: 'nr-1' });
    tx.consultation.update.mockResolvedValue({
      id: 'c-1',
      queue: 'Aguardando exame',
      appointment: { id: 'a-1', type: 'EXAME', specialty: 'Tomografia', observations: '' },
      nursingResponse: { id: 'nr-1', answers: [{ orderIndex: 1 }] },
    });

    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));
  });

  it('enforces auth and branch checks', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/consultations' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    const app = await buildApp();
    res = await app.inject({ method: 'GET', url: '/consultations' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('lists and gets consultations', async () => {
    mockedPrisma.consultation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'c-1', appointment: null, nursingResponse: null });

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/consultations?search=maria&queueType=FILA_CLINICA' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    res = await app.inject({ method: 'GET', url: '/consultations/c-1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/consultations/c-1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('creates consultation with duplicate prevention and success fallback', async () => {
    mockedPrisma.consultation.findFirst
      .mockResolvedValueOnce({ id: 'c-existing' })
      .mockResolvedValueOnce(null);

    const app = await buildApp();

    let res = await app.inject({
      method: 'POST',
      url: '/consultations',
      payload: {
        patientName: 'Maria',
        appointmentId: 'a-1',
        queueType: 'FILA_CLINICA',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(mockedPrisma.consultation.create).not.toHaveBeenCalled();

    res = await app.inject({
      method: 'POST',
      url: '/consultations',
      payload: {
        patientName: 'Maria',
        doctorName: 'Dr A',
        queueType: 'FILA_NORMAL',
      },
    });
    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it('handles nursing triage validation and success', async () => {
    const app = await buildApp();

    mockedPrisma.consultation.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'POST', url: '/consultations/c-1/nursing-triage', payload: {} });
    expect(res.statusCode).toBe(404);

    mockedPrisma.consultation.findFirst.mockResolvedValueOnce({
      id: 'c-1',
      branchId: 'b-1',
      isActive: true,
      appointment: { id: 'a-1', type: 'CONSULTA', specialty: 'Clínica', observations: '' },
      nursingResponse: null,
    });
    res = await app.inject({ method: 'POST', url: '/consultations/c-1/nursing-triage', payload: {} });
    expect(res.statusCode).toBe(400);

    mockedPrisma.consultation.findFirst.mockResolvedValueOnce({
      id: 'c-1',
      branchId: 'b-1',
      isActive: true,
      bloodPressure: null,
      appointment: { id: 'a-1', type: 'EXAME', specialty: 'Tomografia', observations: '' },
      nursingResponse: null,
    });
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([]);
    res = await app.inject({ method: 'POST', url: '/consultations/c-1/nursing-triage', payload: {} });
    expect(res.statusCode).toBe(404);

    mockedPrisma.consultation.findFirst.mockResolvedValueOnce({
      id: 'c-1',
      branchId: 'b-1',
      isActive: true,
      bloodPressure: null,
      heartRate: null,
      temperature: null,
      oxygenSaturation: null,
      weight: null,
      height: null,
      glucose: null,
      pregnant: null,
      triageNotes: null,
      appointment: { id: 'a-1', type: 'EXAME', specialty: 'Tomografia', observations: '' },
      nursingResponse: null,
    });
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([
      {
        name: 'Tomografia',
        nursingTemplates: [
          {
            id: 'nt-1',
            name: 'Template',
            collectBloodPressure: true,
            collectHeartRate: false,
            collectTemperature: false,
            collectOxygenSaturation: false,
            collectWeight: false,
            collectHeight: false,
            collectGlucose: false,
            collectPregnancyCheck: false,
            questions: [{ label: 'Pergunta 1', isRequired: true, options: [] }],
          },
        ],
      },
    ]);
    res = await app.inject({ method: 'POST', url: '/consultations/c-1/nursing-triage', payload: {} });
    expect(res.statusCode).toBe(400);

    mockedPrisma.consultation.findFirst.mockResolvedValueOnce({
      id: 'c-1',
      branchId: 'b-1',
      isActive: true,
      bloodPressure: null,
      heartRate: null,
      temperature: null,
      oxygenSaturation: null,
      weight: null,
      height: null,
      glucose: null,
      pregnant: null,
      triageNotes: null,
      appointment: { id: 'a-1', type: 'EXAME', specialty: 'Tomografia', observations: '' },
      nursingResponse: null,
    });
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([
      {
        name: 'Tomografia',
        nursingTemplates: [
          {
            id: 'nt-1',
            name: 'Template',
            collectBloodPressure: true,
            collectHeartRate: false,
            collectTemperature: false,
            collectOxygenSaturation: false,
            collectWeight: false,
            collectHeight: false,
            collectGlucose: false,
            collectPregnancyCheck: false,
            questions: [{ label: 'Pergunta 1', isRequired: true, options: [] }],
          },
        ],
      },
    ]);
    res = await app.inject({
      method: 'POST',
      url: '/consultations/c-1/nursing-triage',
      payload: {
        bloodPressure: '12x8',
        answers: [{ questionLabel: 'Pergunta 1', responseType: 'TEXT', answerText: 'ok' }],
      },
    });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('updates consultation transitions and deletes', async () => {
    mockedPrisma.consultation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'c-1', queue: 'Aguardando atendimento', triageNotes: null, appointment: { observations: '' } })
      .mockResolvedValueOnce({ id: 'c-1', queue: 'Aguardando atendimento', triageNotes: null, appointment: { observations: '[MODALIDADE: TELECONSULTA]' } })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'c-1' });

    const app = await buildApp();

    let res = await app.inject({ method: 'PUT', url: '/consultations/c-1', payload: { queue: 'Exame concluido' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/consultations/c-1', payload: { queue: 'Em atendimento' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PUT', url: '/consultations/c-1', payload: { queue: 'Em atendimento' } });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'DELETE', url: '/consultations/c-1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/consultations/c-1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('returns 400 when creating consultation fails', async () => {
    mockedPrisma.consultation.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.consultation.create.mockRejectedValueOnce(new Error('db-fail'));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/consultations',
      payload: {
        patientName: 'Maria',
        doctorName: 'Dr A',
        queueType: 'FILA_NORMAL',
      },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('completes exam queue and syncs appointment/invoice', async () => {
    mockedPrisma.consultation.findFirst.mockResolvedValueOnce({
      id: 'c-1',
      appointmentId: 'a-1',
      queue: 'Em exame',
      triageNotes: null,
      patientName: 'Maria',
      doctorName: 'Dr A',
      agenda: '09:00 • Tomografia • Dr A',
      appointment: { observations: '' },
    });
    mockedPrisma.consultation.update.mockResolvedValueOnce({
      id: 'c-1',
      appointmentId: 'a-1',
      patientName: 'Maria',
      doctorName: 'Dr A',
      convenio: 'Plano X',
      mainComplaint: 'Dor',
      anamnese: 'Anamnese',
      triageNotes: 'ok',
    });
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-1',
      branchId: 'b-1',
      isActive: true,
      patientId: 'p-1',
      patientName: 'Maria',
      patientCpf: '11144477735',
      doctorName: 'Dr A',
      specialty: 'Tomografia',
      type: 'EXAME',
      date: '2026-04-14',
      time: '09:00',
      status: 'AGENDADO',
      convenio: 'Plano X',
      observations: '',
      authorizedAt: null,
    });
    mockedPrisma.invoice.findUnique.mockResolvedValueOnce(null);
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([
      { id: 'proc-1', name: 'Tomografia', price: 120, tussCode: 'TUSS-1', tussTableCode: '22' },
    ]);
    mockedPrisma.invoice.create.mockResolvedValueOnce({ id: 'inv-1' });

    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/consultations/c-1',
      payload: { queue: 'Exame concluido', appointmentId: 'a-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.appointment.update).toHaveBeenCalled();
    expect(mockedPrisma.invoice.create).toHaveBeenCalled();
    await app.close();
  });

  it('adds where.OR for search when no doctor context, and filters by convenioStatus', async () => {
    mockedPrisma.user.findUnique.mockResolvedValueOnce({
      sector: { branch: { id: 'b-1' } },
      doctor: null,
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/consultations?search=teste&convenioStatus=ATIVO' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('enriches listed consultations with nursingTemplate when found', async () => {
    mockedPrisma.consultation.findMany.mockResolvedValueOnce([{
      id: 'c-1',
      appointment: { id: 'a-1', type: 'EXAME', specialty: 'Tomografia', date: '2026-04-14', time: '09:00', observations: '' },
      nursingResponse: { id: 'nr-1', answers: [{ orderIndex: 0 }] },
    }]);
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([{
      name: 'Tomografia',
      nursingTemplates: [{
        id: 'nt-1',
        name: 'Template Tomo',
        description: null,
        collectBloodPressure: false,
        collectHeartRate: false,
        collectTemperature: false,
        collectOxygenSaturation: false,
        collectWeight: false,
        collectHeight: false,
        collectGlucose: false,
        collectPregnancyCheck: false,
        questions: [{ orderIndex: 1, options: [{ orderIndex: 0 }], label: 'P1', isRequired: false }],
      }],
    }]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/consultations' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].triageRequired).toBe(true);
    await app.close();
  });

  it('gets consultation by id with nursingTemplate found', async () => {
    mockedPrisma.consultation.findFirst.mockResolvedValueOnce({
      id: 'c-1',
      branchId: 'b-1',
      appointment: { id: 'a-1', type: 'EXAME', specialty: 'Tomografia', observations: '' },
      nursingResponse: null,
    });
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([{
      name: 'Tomografia',
      nursingTemplates: [{
        id: 'nt-1',
        name: 'Template Tomo',
        description: null,
        collectBloodPressure: false,
        collectHeartRate: false,
        collectTemperature: false,
        collectOxygenSaturation: false,
        collectWeight: false,
        collectHeight: false,
        collectGlucose: false,
        collectPregnancyCheck: false,
        questions: [],
      }],
    }]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/consultations/c-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().triageRequired).toBe(true);
    await app.close();
  });

  it('creates consultation with exam appointment + nursingTemplate → queue Aguardando triagem', async () => {
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-1', type: 'EXAME', specialty: 'Tomografia',
      date: '2026-04-14', time: '09:00', observations: '',
    });
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([{
      name: 'Tomografia',
      nursingTemplates: [{
        id: 'nt-1', name: 'Tpl',
        collectBloodPressure: false, collectHeartRate: false, collectTemperature: false,
        collectOxygenSaturation: false, collectWeight: false, collectHeight: false,
        collectGlucose: false, collectPregnancyCheck: false,
        questions: [],
      }],
    }]);
    mockedPrisma.consultation.findFirst
      .mockResolvedValueOnce(null) // existingByAppointment
      .mockResolvedValueOnce(null); // existingToday
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/consultations',
      payload: { patientName: 'Maria', appointmentId: 'a-1', queueType: 'FILA_CLINICA' },
    });
    expect(res.statusCode).toBe(201);
    expect(mockedPrisma.consultation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ queue: 'Aguardando triagem' }) }),
    );
    await app.close();
  });

  it('creates consultation with exam appointment, no nursingTemplate → queue Aguardando exame', async () => {
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-1', type: 'EXAME', specialty: 'Tomografia',
      date: '2026-04-14', time: '09:00', observations: '',
    });
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([]); // no procedures → no nursingTemplate
    mockedPrisma.consultation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/consultations',
      payload: { patientName: 'Maria', appointmentId: 'a-1', queueType: 'FILA_CLINICA' },
    });
    expect(res.statusCode).toBe(201);
    expect(mockedPrisma.consultation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ queue: 'Aguardando exame' }) }),
    );
    await app.close();
  });

  it('returns existingToday consultation for FILA_CLINICA with no appointmentId', async () => {
    mockedPrisma.consultation.findFirst.mockResolvedValueOnce({ id: 'c-today', queue: 'Aguardando atendimento' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/consultations',
      payload: { patientName: 'Maria', queueType: 'FILA_CLINICA' },
    });
    expect(res.statusCode).toBe(201);
    expect(mockedPrisma.consultation.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('uses data.queue when no nursingTemplate for non-clinical queue', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/consultations',
      payload: { patientName: 'Maria', queueType: 'FILA_NORMAL', queue: 'Em atendimento' },
    });
    expect(res.statusCode).toBe(201);
    expect(mockedPrisma.consultation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ queue: 'Em atendimento' }) }),
    );
    await app.close();
  });

  it('nursing triage replaces existing response with answerValues, Boolean, Number answer types', async () => {
    mockedPrisma.consultation.findFirst.mockResolvedValueOnce({
      id: 'c-1', branchId: 'b-1', isActive: true,
      bloodPressure: null, heartRate: null, temperature: null, oxygenSaturation: null,
      weight: null, height: null, glucose: null, pregnant: null, triageNotes: null,
      appointment: { id: 'a-1', type: 'EXAME', specialty: 'Tomografia', observations: '' },
      nursingResponse: { id: 'nr-old' },
    });
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([{
      name: 'Tomografia',
      nursingTemplates: [{
        id: 'nt-1', name: 'Template',
        collectBloodPressure: true, collectHeartRate: false, collectTemperature: false,
        collectOxygenSaturation: false, collectWeight: false, collectHeight: false,
        collectGlucose: false, collectPregnancyCheck: false,
        questions: [{ label: 'Sintomas', isRequired: false, orderIndex: 0, options: [] }],
      }],
    }]);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/consultations/c-1/nursing-triage',
      payload: {
        bloodPressure: '12x8',
        answers: [
          { questionLabel: 'Sintomas', responseType: 'BOOLEAN', answerBoolean: true, answerValues: ['x', 'y'] },
          { questionLabel: 'Dose', responseType: 'NUMBER', answerNumber: 5, orderIndex: 1 },
          { questionLabel: 'Obs', responseType: 'TIPO_INVALIDO' }, // filtered out
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(tx.consultationNursingAnswer.deleteMany).toHaveBeenCalled();
    expect(tx.consultationNursingResponse.delete).toHaveBeenCalled();
    await app.close();
  });

  it('updates consultation without queue change (hasQueueStatusChange = false)', async () => {
    mockedPrisma.consultation.findFirst.mockResolvedValueOnce({
      id: 'c-1', queue: 'Aguardando atendimento', triageNotes: null,
      appointment: { observations: '' },
    });
    mockedPrisma.consultation.update.mockResolvedValueOnce({ id: 'c-1', queue: 'Aguardando atendimento' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT', url: '/consultations/c-1',
      payload: { patientName: 'Maria Atualizada' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.appointment.findFirst).not.toHaveBeenCalled();
    await app.close();
  });

  it('allows direct EM_ATENDIMENTO transition for teleconsultation', async () => {
    mockedPrisma.consultation.findFirst.mockResolvedValueOnce({
      id: 'c-1', queue: 'Aguardando atendimento', triageNotes: null,
      appointment: { observations: '[MODALIDADE: TELECONSULTA]' },
    });
    mockedPrisma.consultation.update.mockResolvedValueOnce({ id: 'c-1', queue: 'Em atendimento' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT', url: '/consultations/c-1',
      payload: { queue: 'Em atendimento' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('syncs appointment via candidate search for ATENDIMENTO_CONCLUIDO, skips already-REALIZADO and existing invoice', async () => {
    mockedPrisma.consultation.findFirst.mockResolvedValueOnce({
      id: 'c-1', queue: 'Em atendimento', triageNotes: null, appointmentId: null,
      patientName: 'Maria', doctorName: 'Dr A', agenda: '09:00 • Clinica • Dr A',
      appointment: { observations: '' },
    });
    mockedPrisma.consultation.update.mockResolvedValueOnce({
      id: 'c-1', appointmentId: null, patientName: 'Maria', doctorName: 'Dr A',
      agenda: '09:00 • Clinica • Dr A', convenio: null, mainComplaint: null,
      anamnese: null, triageNotes: null,
    });
    // findTodayAppointmentCandidate → appointment.findMany
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([{
      id: 'a-1', status: 'EM_ATENDIMENTO', patientName: 'Maria', doctorName: 'Dr A',
      date: '2026-04-14', time: '09:00', specialty: 'Clinica',
    }]);
    // appointment is NOT in CONFIRMED set but is EM_ATENDIMENTO so candidates.find returns it
    // Then appointment update (status is not REALIZADO)
    // invoice already exists
    mockedPrisma.invoice.findUnique.mockResolvedValueOnce({ id: 'inv-existing' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT', url: '/consultations/c-1',
      payload: { queue: 'Atendimento concluido' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.appointment.findMany).toHaveBeenCalled();
    expect(mockedPrisma.invoice.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('skips appointment.update when appointment status is already REALIZADO', async () => {
    mockedPrisma.consultation.findFirst.mockResolvedValueOnce({
      id: 'c-1', queue: 'Em exame', triageNotes: null, appointmentId: 'a-1',
      patientName: 'Maria', appointment: { observations: '' },
    });
    mockedPrisma.consultation.update.mockResolvedValueOnce({
      id: 'c-1', appointmentId: 'a-1', patientName: 'Maria', doctorName: 'Dr A',
      convenio: null, mainComplaint: null, anamnese: null, triageNotes: null,
    });
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-1', status: 'REALIZADO', branchId: 'b-1', isActive: true,
      type: 'EXAME', specialty: 'Tomografia', date: '2026-04-14', time: '09:00',
      convenio: null, patientCpf: null, patientId: null, patientName: 'Maria',
      doctorName: 'Dr A', observations: '', authorizedAt: null,
    });
    mockedPrisma.invoice.findUnique.mockResolvedValueOnce(null);
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([
      { id: 'proc-1', name: 'Tomografia', price: 200, tussCode: 'T-1', tussTableCode: '22' },
    ]);
    mockedPrisma.preSchedulingFlow.findUnique.mockResolvedValueOnce(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT', url: '/consultations/c-1',
      payload: { queue: 'Exame concluido', appointmentId: 'a-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.appointment.update).not.toHaveBeenCalled();
    expect(mockedPrisma.invoice.create).toHaveBeenCalled();
    await app.close();
  });

  it('creates invoice for ATENDIMENTO_CONCLUIDO using doctor consultationFee', async () => {
    mockedPrisma.consultation.findFirst.mockResolvedValueOnce({
      id: 'c-1', queue: 'Em atendimento', triageNotes: null, appointmentId: 'a-1',
      doctorId: 'doc-1', doctorName: 'Dr A',
      appointment: { observations: '' },
    });
    mockedPrisma.consultation.update.mockResolvedValueOnce({
      id: 'c-1', appointmentId: 'a-1', doctorId: 'doc-1', doctorName: 'Dr A',
      patientName: 'Maria', convenio: null, mainComplaint: null, anamnese: null, triageNotes: null,
    });
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-1', status: 'AGENDADO', branchId: 'b-1', isActive: true, type: 'CONSULTA',
      specialty: 'Clinica', date: '2026-04-14', time: '09:00', convenio: null,
      patientCpf: '12345678901', patientId: 'p-1', patientName: 'Maria',
      doctorName: 'Dr A', observations: '', authorizedAt: null,
    });
    mockedPrisma.invoice.findUnique.mockResolvedValueOnce(null);
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([]); // no procedures for CONSULTA type
    mockedPrisma.doctor.findFirst
      .mockResolvedValueOnce({ consultationFee: 150, name: 'Dr A', cpf: '12345678901', crm: '1234', crmState: 'SP' }) // resolveBillingItem
      .mockResolvedValueOnce({ consultationFee: 150, name: 'Dr A', cpf: '12345678901', crm: '1234', crmState: 'SP' }); // resolveClinicalGuideSnapshot
    mockedPrisma.patient.findFirst.mockResolvedValueOnce({
      id: 'p-1', healthInsuranceName: 'Plano X', healthInsuranceNumber: 'CARD-1',
      healthInsuranceExpiry: null, hasGuardian: false, name: 'Maria', cpf: '12345678901',
      guardianName: null,
    });
    mockedPrisma.preSchedulingFlow.findUnique.mockResolvedValueOnce({ guideNumber: 'G-001' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT', url: '/consultations/c-1',
      payload: { queue: 'Atendimento concluido', appointmentId: 'a-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.invoice.create).toHaveBeenCalled();
    await app.close();
  });

  it('creates invoice for completed consultation with guardian beneficiary snapshot', async () => {
    mockedPrisma.consultation.findFirst.mockResolvedValueOnce({
      id: 'c-1', queue: 'Em atendimento', triageNotes: null, appointmentId: 'a-1',
      doctorId: null, doctorName: 'Dr B',
      appointment: { observations: '' },
    });
    mockedPrisma.consultation.update.mockResolvedValueOnce({
      id: 'c-1', appointmentId: 'a-1', doctorId: null, doctorName: 'Dr B',
      patientName: 'Menor', convenio: null, mainComplaint: 'dor', anamnese: null, triageNotes: null,
    });
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce({
      id: 'a-1', status: 'AGENDADO', branchId: 'b-1', isActive: true, type: 'CONSULTA',
      specialty: 'Pediatria', date: '2026-04-14', time: '10:00', convenio: null,
      patientCpf: null, patientId: 'p-2', patientName: 'Menor',
      doctorName: 'Dr B', observations: '', authorizedAt: new Date('2026-04-10'),
    });
    mockedPrisma.invoice.findUnique.mockResolvedValueOnce(null);
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([]); // no procedures
    // doctor lookup by name (no doctorId)
    mockedPrisma.doctor.findFirst
      .mockResolvedValueOnce(null) // resolveBillingItem by name lookup → null
      .mockResolvedValueOnce(null); // resolveClinicalGuideSnapshot by name → null
    // patient with guardian and expired health insurance → VENCIDO
    mockedPrisma.patient.findFirst.mockResolvedValueOnce({
      id: 'p-2', healthInsuranceName: 'Plano Familiar', healthInsuranceNumber: 'CARD-2',
      healthInsuranceExpiry: new Date('2025-01-01'), // expired → VENCIDO
      hasGuardian: true, name: 'Menor', cpf: '98765432100',
      guardianName: 'Responsavel', guardianCpf: '12345678901', guardianRelationship: 'MAE',
    });
    mockedPrisma.preSchedulingFlow.findUnique.mockResolvedValueOnce(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT', url: '/consultations/c-1',
      payload: { queue: 'Atendimento concluido', appointmentId: 'a-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.invoice.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          holderName: 'Responsavel',
          dependentName: 'Menor',
          beneficiaryStatus: 'VENCIDO',
        }),
      }),
    );
    await app.close();
  });
});
