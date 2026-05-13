import { FastifyInstance } from 'fastify';
import { randomBytes } from 'crypto';
import prisma from '../lib/prisma';
import { decryptFlowRequest, encryptFlowResponse } from '../lib/whatsapp-flow-crypto';

/**
 * WhatsApp Flows data exchange endpoint.
 *
 * Screens:
 *   INTRO        → service type + branch selection
 *   INSURANCE    → insurance selection (dynamic per branch+service)
 *   PROCEDURE    → procedure selection (dynamic per branch+service+insurance)
 *   DATE_PREF    → preferred date picker
 *   PATIENT_DATA → CPF / name / birthdate (pre-filled for known patients)
 *   CONFIRM      → summary before final submit
 *
 * flow_token = base64(JSON{ branchId, phone, conversationId })
 */

// ─── helpers ────────────────────────────────────────────────────────────────

function normalizeText(s: string) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function formatPhoneForLookup(raw: string) {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('55')) return digits.slice(2);
  if (digits.length === 12 && digits.startsWith('55')) return digits.slice(2);
  return digits.slice(-11);
}

const JS_DAY_TO_WEEKDAY: Record<number, string> = {
  0: 'SUNDAY', 1: 'MONDAY', 2: 'TUESDAY', 3: 'WEDNESDAY',
  4: 'THURSDAY', 5: 'FRIDAY', 6: 'SATURDAY',
};

function timeToMinutes(t: string) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function timeRangesOverlap(
  aStart: string, aDuration: number,
  bStart: string, bDuration: number,
) {
  const aS = timeToMinutes(aStart); const aE = aS + aDuration;
  const bS = timeToMinutes(bStart); const bE = bS + bDuration;
  return aS < bE && bS < aE;
}

function formatDateIso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDateBR(iso: string) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function resolveDuration(v: unknown) {
  const n = Number(v);
  return n > 0 ? n : 30;
}

function parseDoctorWindows(doctor: any): Array<{ weekdays: string[]; hoursStart: string; hoursEnd: string }> {
  const schedules: any[] = Array.isArray(doctor.workingSchedules) && doctor.workingSchedules.length > 0
    ? doctor.workingSchedules
    : [];
  if (schedules.length > 0) {
    return schedules.map((s: any) => ({
      weekdays: Array.isArray(s.weekdays) ? s.weekdays.map(String) : [],
      hoursStart: String(s.hoursStart || '08:00'),
      hoursEnd: String(s.hoursEnd || '18:00'),
    }));
  }
  const days = Array.isArray(doctor.workingDays) ? doctor.workingDays.map(String) : ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
  return [{ weekdays: days, hoursStart: String(doctor.workingHoursStart || '08:00'), hoursEnd: String(doctor.workingHoursEnd || '18:00') }];
}

function buildWindowSlots(start: string, end: string, step: number) {
  const slots: string[] = [];
  let cur = timeToMinutes(start);
  const endMin = timeToMinutes(end || '23:59');
  while (cur < endMin) {
    slots.push(`${String(Math.floor(cur / 60)).padStart(2, '0')}:${String(cur % 60).padStart(2, '0')}`);
    cur += step;
  }
  return slots;
}

const OPEN_STATUSES = new Set(['AGENDADO', 'CONFIRMADO', 'PENDENTE', 'PENDING', 'RESERVA_WHATSAPP_PENDENTE', 'EM ANDAMENTO', 'EM_ANDAMENTO', 'IN_PROGRESS']);
const DEFAULT_SEARCH_DAYS = 30;

// ─── DB helpers ─────────────────────────────────────────────────────────────

async function getBranches(rootBranchId: string) {
  const root = await prisma.branch.findUnique({ where: { id: rootBranchId }, select: { id: true, tradeName: true, companyId: true } });
  if (!root) return [{ id: rootBranchId, label: 'Unidade principal' }];
  const all = await prisma.branch.findMany({
    where: { companyId: root.companyId, isActive: true },
    select: { id: true, tradeName: true },
    orderBy: { tradeName: 'asc' },
  });
  if (all.length <= 1) return [{ id: root.id, label: root.tradeName || 'Unidade principal' }];
  return all.map((b: any) => ({ id: b.id, label: b.tradeName || 'Sem nome' }));
}

async function getInsurances(branchId: string, serviceType: string) {
  const procedures = await prisma.procedure.findMany({
    where: { branchId, isActive: true, appointmentType: { equals: serviceType, mode: 'insensitive' } },
    select: { acceptedInsurances: true },
  });
  const fromProcs = Array.from(new Set(
    procedures.flatMap((p: any) => Array.isArray(p.acceptedInsurances) ? p.acceptedInsurances : [])
      .map((s: any) => String(s || '').trim()).filter(Boolean),
  ));
  if (fromProcs.length > 0) return (fromProcs as string[]).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  return (await prisma.insurance.findMany({
    where: { branchId, isActive: true },
    select: { name: true },
    orderBy: { name: 'asc' },
  })).map((i: any) => String(i.name).trim()).filter(Boolean);
}

async function getProcedures(branchId: string, serviceType: string, insurance: string) {
  const normalizedIns = normalizeText(insurance);
  const all = await prisma.procedure.findMany({
    where: { branchId, isActive: true, appointmentType: { equals: serviceType, mode: 'insensitive' } },
    select: { id: true, name: true, acceptsInsurance: true, acceptedInsurances: true },
    orderBy: { name: 'asc' },
  });
  return all.filter((p: any) => {
    const accepted = Array.isArray(p.acceptedInsurances) ? p.acceptedInsurances.map((x: any) => normalizeText(String(x))) : [];
    if (accepted.length > 0) return accepted.includes(normalizedIns);
    return Boolean(p.acceptsInsurance);
  }).map((p: any) => ({ id: String(p.id), label: String(p.name) }));
}

async function findSlot(branchId: string, procedureId: string, patientId: string | null, startDateIso?: string) {
  const procedure = await prisma.procedure.findFirst({
    where: { id: procedureId, branchId, isActive: true },
    select: { id: true, durationMinutes: true },
  });
  if (!procedure) return null;

  const links = await prisma.procedureDoctor.findMany({ where: { procedureId }, select: { doctorId: true } });
  const doctorIds = Array.from(new Set(links.map((l: any) => String(l.doctorId)).filter(Boolean)));
  if (!doctorIds.length) return null;

  const doctors = await prisma.doctor.findMany({
    where: { id: { in: doctorIds }, branchId, isActive: true },
    select: { id: true, name: true, workingDays: true, workingHoursStart: true, workingHoursEnd: true, workingSchedules: true },
  });
  if (!doctors.length) return null;

  const duration = resolveDuration(procedure.durationMinutes);
  const startDate = startDateIso ? new Date(`${startDateIso}T00:00:00`) : new Date();
  startDate.setHours(0, 0, 0, 0);

  for (let offset = 0; offset < DEFAULT_SEARCH_DAYS; offset++) {
    const candidate = new Date(startDate);
    candidate.setDate(candidate.getDate() + offset);
    const dateIso = formatDateIso(candidate);
    const weekdayToken = JS_DAY_TO_WEEKDAY[candidate.getDay()];

    const [doctorAppts, patientAppts] = await Promise.all([
      prisma.appointment.findMany({
        where: { branchId, isActive: true, date: dateIso, status: { in: Array.from(OPEN_STATUSES) } },
        select: { doctorName: true, time: true, durationMinutes: true },
      }),
      patientId ? prisma.appointment.findMany({
        where: { patientId, isActive: true, date: dateIso, status: { in: Array.from(OPEN_STATUSES) } },
        select: { time: true, durationMinutes: true },
      }) : Promise.resolve([]),
    ]);

    const now = new Date();
    const isToday = formatDateIso(now) === dateIso;
    const nowMin = now.getHours() * 60 + now.getMinutes();

    for (const doctor of doctors) {
      const windows = parseDoctorWindows(doctor).filter(w => w.weekdays.includes(weekdayToken));
      for (const window of windows) {
        for (const slot of buildWindowSlots(window.hoursStart, window.hoursEnd, 15)) {
          if (isToday && timeToMinutes(slot) <= nowMin) continue;
          if (window.hoursEnd && (timeToMinutes(slot) + duration) > timeToMinutes(window.hoursEnd)) continue;
          const drConflict = doctorAppts.some((a: any) => String(a.doctorName || '').trim() === String(doctor.name || '').trim() && a.time && timeRangesOverlap(slot, duration, String(a.time), resolveDuration(a.durationMinutes)));
          if (drConflict) continue;
          const ptConflict = patientAppts.some((a: any) => a.time && timeRangesOverlap(slot, duration, String(a.time), resolveDuration(a.durationMinutes)));
          if (ptConflict) continue;
          return { doctorId: String(doctor.id), doctorName: String(doctor.name), date: dateIso, time: slot, durationMinutes: duration };
        }
      }
    }
  }
  return null;
}

async function lookupPatient(branchId: string, phone: string) {
  const normalized = formatPhoneForLookup(phone);
  const candidates = await prisma.patient.findMany({
    where: { branchId, isActive: true, OR: [{ cellphone: { contains: normalized } }, { phone: { contains: normalized } }] },
    select: { id: true, name: true, cpf: true, birthDate: true, healthInsuranceName: true },
    take: 1,
  });
  return candidates[0] || null;
}

async function createAppointment(params: {
  branchId: string;
  patientId: string | null;
  patientName: string;
  patientCpf: string | null;
  patientPhone: string;
  doctorId: string;
  doctorName: string;
  date: string;
  time: string;
  durationMinutes: number;
  insurance: string;
  procedureName: string;
  preferredDate: string | null;
}) {
  const publicToken = randomBytes(24).toString('hex');
  const observations = [
    '[WhatsApp FLOW] Agendamento criado via WhatsApp Flow.',
    `Telefone: ${params.patientPhone}`,
    `Convênio: ${params.insurance}`,
    `Procedimento: ${params.procedureName}`,
    `Profissional: ${params.doctorName}`,
    params.preferredDate ? `Preferência informada: ${params.preferredDate}` : '',
    !params.patientId ? 'Paciente ainda não vinculado ao cadastro.' : '',
  ].filter(Boolean).join('\n');

  return prisma.$transaction(async (tx: any) => {
    const appt = await tx.appointment.create({
      data: {
        branchId: params.branchId,
        patientId: params.patientId,
        patientName: params.patientName,
        patientCpf: params.patientCpf,
        doctorName: params.doctorName,
        specialty: params.procedureName,
        convenio: params.insurance,
        date: params.date,
        time: params.time,
        durationMinutes: params.durationMinutes,
        type: 'WHATSAPP',
        status: 'CONFIRMADO',
        authorizationStatus: 'PENDING',
        observations,
      },
    });
    await tx.preSchedulingFlow.create({
      data: {
        branchId: params.branchId,
        appointmentId: appt.id,
        patientId: params.patientId,
        patientName: params.patientName,
        patientCpf: params.patientCpf,
        patientPhone: params.patientPhone,
        source: 'BOT',
        status: 'PENDING',
        publicToken,
      },
    });
    return appt;
  });
}

// ─── screen builder ──────────────────────────────────────────────────────────

interface TokenData { branchId: string; phone: string; conversationId: string }

function decodeToken(token: string): TokenData | null {
  try {
    return JSON.parse(Buffer.from(token, 'base64').toString('utf-8')) as TokenData;
  } catch {
    return null;
  }
}

type DropdownOption = { id: string; title: string };

async function buildResponse(
  action: string,
  screen: string,
  data: Record<string, unknown>,
  tokenData: TokenData,
): Promise<Record<string, unknown>> {
  const { branchId, phone } = tokenData;

  // ── ping ──────────────────────────────────────────────────────────────────
  if (action === 'ping') return { data: { status: 'active' } };

  // ── INIT → INTRO ──────────────────────────────────────────────────────────
  if (action === 'INIT' || screen === 'INTRO') {
    const branches = await getBranches(branchId);
    const showBranches = branches.length > 1;
    return {
      screen: 'INTRO',
      data: {
        services: [
          { id: 'CONSULTA', title: 'Consulta' },
          { id: 'EXAME', title: 'Exame' },
          { id: 'RETORNO', title: 'Retorno' },
        ] as DropdownOption[],
        branches: branches.map((b: { id: string; label: string }) => ({ id: b.id, title: b.label })) as DropdownOption[],
        show_branches: showBranches,
        default_branch_id: branches[0]?.id || branchId,
      },
    };
  }

  // ── INTRO → INSURANCE ────────────────────────────────────────────────────
  if (screen === 'INSURANCE' || (screen === 'INTRO' && action === 'data_exchange')) {
    const serviceType = String(data.service_id || 'CONSULTA').toUpperCase();
    const targetBranch = String(data.branch_id || branchId);
    const insurances = await getInsurances(targetBranch, serviceType);
    const options: DropdownOption[] = [
      ...(insurances as string[]).map((name: string) => ({ id: name, title: name })),
      { id: '__HANDOFF__', title: 'Não encontrei meu convênio' },
    ];
    return {
      screen: 'INSURANCE',
      data: {
        insurances: options,
        service_id: serviceType,
        branch_id: targetBranch,
      },
    };
  }

  // ── INSURANCE → PROCEDURE ────────────────────────────────────────────────
  if (screen === 'PROCEDURE') {
    const serviceType = String(data.service_id || 'CONSULTA').toUpperCase();
    const targetBranch = String(data.branch_id || branchId);
    const insurance = String(data.insurance_id || '');

    if (insurance === '__HANDOFF__') {
      return {
        screen: 'SUCCESS',
        data: {
          extension_message_response: {
            params: { flow_action: 'handoff', reason: 'CONVENIO_NAO_ENCONTRADO' },
          },
        },
      };
    }

    const procedures = await getProcedures(targetBranch, serviceType, insurance);
    const options: DropdownOption[] = [
      ...(procedures as { id: string; label: string }[]).map((p: { id: string; label: string }) => ({ id: p.id, title: p.label })),
      { id: '__HANDOFF__', title: 'Não encontrei meu procedimento' },
    ];
    return {
      screen: 'PROCEDURE',
      data: {
        procedures: options,
        service_id: serviceType,
        branch_id: targetBranch,
        insurance_id: insurance,
      },
    };
  }

  // ── PROCEDURE → DATE_PREF ────────────────────────────────────────────────
  if (screen === 'DATE_PREF') {
    const procedureId = String(data.procedure_id || '');

    if (procedureId === '__HANDOFF__') {
      return {
        screen: 'SUCCESS',
        data: {
          extension_message_response: {
            params: { flow_action: 'handoff', reason: 'PROCEDIMENTO_NAO_ENCONTRADO' },
          },
        },
      };
    }

    const today = new Date();
    const minDate = formatDateIso(today);
    const maxDate = (() => {
      const d = new Date(today);
      d.setMonth(d.getMonth() + 3);
      return formatDateIso(d);
    })();

    return {
      screen: 'DATE_PREF',
      data: {
        min_date: minDate,
        max_date: maxDate,
        service_id: data.service_id,
        branch_id: data.branch_id,
        insurance_id: data.insurance_id,
        procedure_id: procedureId,
      },
    };
  }

  // ── DATE_PREF → PATIENT_DATA ─────────────────────────────────────────────
  if (screen === 'PATIENT_DATA') {
    const patient = await lookupPatient(branchId, phone);
    return {
      screen: 'PATIENT_DATA',
      data: {
        prefill_cpf: patient?.cpf ? String(patient.cpf) : '',
        prefill_name: patient?.name ? String(patient.name) : '',
        prefill_birthdate: patient?.birthDate ? String(patient.birthDate).slice(0, 10) : '',
        is_known_patient: Boolean(patient),
        service_id: data.service_id,
        branch_id: data.branch_id,
        insurance_id: data.insurance_id,
        procedure_id: data.procedure_id,
        preferred_date: data.preferred_date || '',
      },
    };
  }

  // ── PATIENT_DATA → CONFIRM ───────────────────────────────────────────────
  if (screen === 'CONFIRM') {
    const targetBranch = String(data.branch_id || branchId);
    const procedureId = String(data.procedure_id || '');
    const preferredDate = String(data.preferred_date || '');
    const patientName = String(data.patient_name || '');
    const insurance = String(data.insurance_id || '');

    const procedure = await prisma.procedure.findFirst({
      where: { id: procedureId, isActive: true },
      select: { name: true },
    });

    const patient = await lookupPatient(branchId, phone);
    const slot = await findSlot(targetBranch, procedureId, patient?.id || null, preferredDate || undefined);

    const slotLabel = slot
      ? `${formatDateBR(slot.date)} às ${slot.time} com ${slot.doctorName}`
      : preferredDate
        ? `Preferência: ${formatDateBR(preferredDate)} (a confirmar pela clínica)`
        : 'A definir pela clínica';

    const branchInfo = await prisma.branch.findUnique({ where: { id: targetBranch }, select: { tradeName: true } });
    const serviceLabel = String(data.service_id || '').toLowerCase() === 'exame' ? 'Exame' : String(data.service_id || '').toLowerCase() === 'retorno' ? 'Retorno' : 'Consulta';

    const summary = [
      `Serviço: ${serviceLabel}`,
      `Unidade: ${branchInfo?.tradeName || 'Clínica'}`,
      `Convênio: ${insurance}`,
      `Procedimento: ${procedure?.name || procedureId}`,
      `Horário: ${slotLabel}`,
      `Paciente: ${patientName}`,
    ].join('\n');

    return {
      screen: 'CONFIRM',
      data: {
        summary,
        service_id: data.service_id,
        branch_id: targetBranch,
        insurance_id: insurance,
        procedure_id: procedureId,
        preferred_date: preferredDate,
        patient_name: patientName,
        patient_cpf: data.patient_cpf || '',
        patient_birthdate: data.patient_birthdate || '',
        slot_date: slot?.date || '',
        slot_time: slot?.time || '',
        slot_doctor_id: slot?.doctorId || '',
        slot_doctor_name: slot?.doctorName || '',
        slot_duration: String(slot?.durationMinutes || 30),
      },
    };
  }

  // ── CONFIRM submit → create appointment ──────────────────────────────────
  if (screen === 'SUCCESS') {
    const targetBranch = String(data.branch_id || branchId);
    const procedureId = String(data.procedure_id || '');
    const insurance = String(data.insurance_id || '');
    const patientName = String(data.patient_name || 'Paciente');
    const patientCpf = String(data.patient_cpf || '') || null;
    const patientBirthdate = String(data.patient_birthdate || '') || null;
    const preferredDate = String(data.preferred_date || '') || null;

    const slotDate = String(data.slot_date || '');
    const slotTime = String(data.slot_time || '');
    const slotDoctorId = String(data.slot_doctor_id || '');
    const slotDoctorName = String(data.slot_doctor_name || '');
    const slotDuration = Number(data.slot_duration || 30);

    // Look up (or create) patient
    let patient = await lookupPatient(branchId, phone);
    if (!patient && patientName && patientCpf) {
      try {
        patient = await prisma.patient.create({
          data: {
            branchId,
            name: patientName,
            cpf: patientCpf,
            birthDate: patientBirthdate,
            cellphone: formatPhoneForLookup(phone),
            healthInsuranceName: insurance,
            isActive: true,
          },
        });
      } catch { /* patient may exist with different data, proceed without */ }
    }

    // Get procedure name
    const procedure = await prisma.procedure.findFirst({
      where: { id: procedureId, isActive: true },
      select: { name: true },
    });
    const procedureName = procedure?.name || procedureId;

    // Find slot if not pre-computed
    let slot = slotDate && slotTime && slotDoctorId
      ? { doctorId: slotDoctorId, doctorName: slotDoctorName, date: slotDate, time: slotTime, durationMinutes: slotDuration }
      : await findSlot(targetBranch, procedureId, patient?.id || null, preferredDate || undefined);

    if (!slot) {
      // No slot found — create without specific time, let clinic confirm
      slot = { doctorId: '', doctorName: 'A confirmar', date: preferredDate || formatDateIso(new Date()), time: '09:00', durationMinutes: 30 };
    }

    await createAppointment({
      branchId: targetBranch,
      patientId: patient?.id || null,
      patientName,
      patientCpf,
      patientPhone: formatPhoneForLookup(phone),
      doctorId: slot.doctorId,
      doctorName: slot.doctorName,
      date: slot.date,
      time: slot.time,
      durationMinutes: slot.durationMinutes,
      insurance,
      procedureName,
      preferredDate,
    });

    return {
      screen: 'SUCCESS',
      data: {
        extension_message_response: {
          params: {
            flow_action: 'appointment_created',
            patient_name: patientName,
            procedure_name: procedureName,
            slot_label: `${formatDateBR(slot.date)} às ${slot.time}`,
          },
        },
      },
    };
  }

  // fallback
  return { screen: 'INTRO', data: {} };
}

// ─── route ───────────────────────────────────────────────────────────────────

export default async function whatsappFlowRoutes(app: FastifyInstance) {
  app.get('/whatsapp/flow/exchange', async (request, reply) => {
    const query = request.query as Record<string, string>;
    if (query.challenge) return reply.send(query.challenge);
    return { ok: true };
  });

  app.post('/whatsapp/flow/exchange', {
    schema: {
      summary: 'WhatsApp Flow data exchange',
      tags: ['WhatsApp'],
      body: { type: 'object', additionalProperties: true },
    },
  }, async (request, reply) => {
    const body = request.body as any;
    const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;

    if (!encrypted_aes_key || !encrypted_flow_data || !initial_vector) {
      return reply.status(400).send({ error: 'Missing encrypted fields' });
    }

    let decryptResult;
    try {
      decryptResult = decryptFlowRequest(encrypted_aes_key, encrypted_flow_data, initial_vector);
    } catch (err: any) {
      request.log.error({ err: err.message }, 'Flow decryption failed');
      return reply.status(421).send({ error: 'Decryption failed' });
    }

    const payload = decryptResult.decryptedBody as any;
    request.log.info({ action: payload.action, screen: payload.screen, flowToken: payload.flow_token }, 'WhatsApp Flow exchange');

    const tokenData = decodeToken(String(payload.flow_token || ''));
    if (!tokenData?.branchId) {
      request.log.warn({ flowToken: payload.flow_token }, 'Invalid flow_token');
      const enc = encryptFlowResponse({ screen: 'INTRO', data: { error: 'Token inválido.' } }, decryptResult.aesKeyBuffer, decryptResult.ivBuffer);
      return reply.send(enc);
    }

    let screenResponse: Record<string, unknown>;
    try {
      screenResponse = await buildResponse(
        String(payload.action || ''),
        String(payload.screen || 'INTRO'),
        (payload.data || {}) as Record<string, unknown>,
        tokenData,
      );
    } catch (err: any) {
      request.log.error({ err: err.message }, 'Flow screen build failed');
      screenResponse = { screen: 'INTRO', data: { error: 'Erro interno. Tente novamente.' } };
    }

    const encrypted = encryptFlowResponse(screenResponse, decryptResult.aesKeyBuffer, decryptResult.ivBuffer);
    return reply.send(encrypted);
  });
}
