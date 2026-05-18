import type { Appointment as AppointmentModel, PreAttendance as PreAttendanceModel } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

const CLINIC_TIME_ZONE = process.env.APP_TIMEZONE || 'America/Sao_Paulo';

function maskCpf(cpf: string | null | undefined): string {
  const digits = String(cpf || '').replace(/\D/g, '');
  if (digits.length !== 11) return '***.***.***-**';
  return `***.***.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

type DoctorQueueLookup = {
  id: string;
  name: string;
};

type AuthorizedBranchContext = {
  id: string;
  tradeName: string;
  phone: string | null;
  companyId: string;
  publicCheckInEnabled: boolean;
  requireFacialForPatientRegistration: boolean;
};

type RequestAccessContext = {
  id?: string;
  companyId?: string | null;
  branchId?: string | null;
  admHubOnly?: boolean;
};

const CONFIRMED_APPOINTMENT_STATUSES = new Set(['CONFIRMADO', 'CONFIRMED']);
const CLOSED_PRE_ATTENDANCE_STATUSES = new Set(['FINALIZADO', 'FINALIZADA', 'CANCELADO', 'CANCELADA']);
const ADVANCED_PRE_ATTENDANCE_STATUSES = new Set([
  'EM ATENDIMENTO NA RECEPCAO',
  'CHECKLIST EM ANDAMENTO',
  'RECEPCAO CONCLUIDA',
  'FINALIZADO',
  'FINALIZADA',
]);

const normalizeStatus = (value?: string | null) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toUpperCase();
const normalizeCpf = (value?: string | null) => String(value || '').replace(/\D/g, '');

const parseAppointmentDateTime = (date?: string | null, time?: string | null) => {
  const normalizedDate = String(date || '').trim();
  const normalizedTime = String(time || '').trim();
  if (!normalizedDate || !normalizedTime) return null;

  const [year, month, day] = normalizedDate.split('-').map(Number);
  const [hours, minutes] = normalizedTime.split(':').map(Number);
  if ([year, month, day, hours, minutes].some((value) => Number.isNaN(value))) return null;

  return new Date(year, month - 1, day, hours, minutes, 0, 0);
};

const formatNaiveDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatNaiveTime = (date: Date) => {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
};

const getTimeZoneParts = (date: Date, timeZone = CLINIC_TIME_ZONE) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const readPart = (type: string) => parts.find((item) => item.type === type)?.value || '';

  return {
    year: readPart('year'),
    month: readPart('month'),
    day: readPart('day'),
    hour: readPart('hour'),
    minute: readPart('minute'),
    second: readPart('second'),
  };
};

const getTimeZoneOffsetMinutes = (date: Date, timeZone = CLINIC_TIME_ZONE) => {
  const { year, month, day, hour, minute, second } = getTimeZoneParts(date, timeZone);
  const asUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    0,
  );
  return (asUtc - date.getTime()) / 60000;
};

const createDateForTimeZone = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
  timeZone = CLINIC_TIME_ZONE,
) => {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  const offsetMinutes = getTimeZoneOffsetMinutes(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - (offsetMinutes * 60 * 1000));
};

const getClinicNowDateTime = () => {
  const { year, month, day, hour, minute } = getTimeZoneParts(new Date());
  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`,
  };
};

const getCheckInQueueStatus = (appointmentDate?: string | null, appointmentTime?: string | null) => {
  const appointmentAt = parseAppointmentDateTime(appointmentDate, appointmentTime);
  if (!appointmentAt) return 'Na fila da recepção';

  const delayedAt = new Date(appointmentAt.getTime() + (30 * 60 * 1000));
  const clinicNow = getClinicNowDateTime();
  const delayedDateIso = formatNaiveDate(delayedAt);
  const delayedTime = formatNaiveTime(delayedAt);

  if (
    clinicNow.date > delayedDateIso
    || (clinicNow.date === delayedDateIso && clinicNow.time > delayedTime)
  ) {
    return 'Atrasado';
  }

  return 'Na fila da recepção';
};

const getTodayDateString = () => getClinicNowDateTime().date;

const getTodayBounds = () => {
  const { year, month, day } = getTimeZoneParts(new Date());
  const start = createDateForTimeZone(Number(year), Number(month), Number(day), 0, 0, 0, 0);
  const end = createDateForTimeZone(Number(year), Number(month), Number(day), 23, 59, 59, 999);

  return { start, end };
};

const formatAppointmentSummary = (appointment: {
  time?: string | null;
  specialty?: string | null;
  doctorName?: string | null;
}) => [appointment.time, appointment.specialty, appointment.doctorName].filter(Boolean).join(' • ');

const getAuthorizedBranchContext = async (
  requestUser: RequestAccessContext,
  branchId: string,
): Promise<AuthorizedBranchContext | null> => {
  if (requestUser?.admHubOnly) {
    return null;
  }

  let companyId = String(requestUser?.companyId || '').trim() || null;

  if (!companyId && requestUser?.id) {
    const user = await prisma.user.findUnique({
      where: { id: requestUser.id },
      include: { sector: { include: { branch: true } } },
    });

    companyId = user?.sector?.branch?.companyId || null;
  }

  if (!companyId) {
    return null;
  }

  const branch = await prisma.branch.findUnique({
    where: { id: branchId },
    select: {
      id: true,
      tradeName: true,
      phone: true,
      companyId: true,
      settings: {
        select: {
          publicCheckInEnabled: true,
          requireFacialForPatientRegistration: true,
        },
      },
    },
  });

  if (!branch || branch.companyId !== companyId) {
    return null;
  }

  return {
    id: branch.id,
    tradeName: branch.tradeName,
    phone: branch.phone,
    companyId: branch.companyId,
    publicCheckInEnabled: Boolean(branch.settings?.publicCheckInEnabled),
    requireFacialForPatientRegistration: branch.settings?.requireFacialForPatientRegistration ?? true,
  };
};

export default async function publicCheckInRoutes(app: FastifyInstance) {
  app.get('/branch/:branchId', {
    preHandler: async (request) => { await request.jwtVerify(); },
    schema: {
      summary: 'Get public branch info for kiosk/totem',
      tags: ['PublicCheckIn'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['branchId'],
        properties: {
          branchId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { branchId } = request.params as { branchId: string };
    const branch = await getAuthorizedBranchContext(request.user as RequestAccessContext, branchId);

    if (!branch) {
      return reply.code(403).send({ error: 'Acesso negado para esta filial.' });
    }

    return {
      id: branch.id,
      tradeName: branch.tradeName,
      phone: branch.phone,
      publicCheckInEnabled: branch.publicCheckInEnabled,
      requireFacialForPatientRegistration: branch.requireFacialForPatientRegistration,
    };
  });

  app.post('/facial', {
    preHandler: async (request) => { await request.jwtVerify(); },
    schema: {
      summary: 'Public facial check-in for kiosk/totem',
      tags: ['PublicCheckIn'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['branchId'],
        properties: {
          branchId: { type: 'string' },
          patientId: { type: 'string' },
          patientCpf: { type: 'string' },
          patientName: { type: 'string' },
          trust: { type: 'number' },
          totem: { type: 'number' },
        },
      },
    },
  }, async (request, reply) => {
    const { branchId, patientId, patientCpf, patientName, trust, totem } = request.body as {
      branchId: string;
      patientId?: string;
      patientCpf?: string;
      patientName?: string;
      trust?: number;
      totem?: number;
    };

    if (!branchId) {
      return reply.code(400).send({ error: 'branchId is required' });
    }

    const authorizedBranch = await getAuthorizedBranchContext(request.user as RequestAccessContext, branchId);

    if (!authorizedBranch) {
      return reply.code(403).send({ error: 'Acesso negado para esta filial.' });
    }

    if (!authorizedBranch.publicCheckInEnabled) {
      return reply.code(403).send({
        error: 'O check-in público desta filial está desligado no momento.',
        code: 'PUBLIC_CHECKIN_DISABLED',
      });
    }

    const normalizedCpf = normalizeCpf(patientCpf);

    const patientLookupConditions = [
      patientId ? { id: patientId } : null,
      normalizedCpf ? { cpf: normalizedCpf } : null,
    ].filter(Boolean);

    if (!patientLookupConditions.length) {
      return reply.code(400).send({
        status: 'PATIENT_NOT_FOUND',
        message: 'Dados insuficientes para localizar o paciente reconhecido.',
      });
    }

    const patient = await prisma.patient.findFirst({
      where: {
        branchId,
        isActive: true,
        OR: patientLookupConditions as any,
      },
    });

    if (!patient) {
      return reply.code(404).send({
        status: 'PATIENT_NOT_FOUND',
        message: 'Paciente não encontrado para esta filial.',
      });
    }

    const today = getTodayDateString();

    const appointments: AppointmentModel[] = await prisma.appointment.findMany({
      where: {
        branchId,
        isActive: true,
        patientId: patient.id,
        date: today,
      },
      orderBy: [
        { time: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    const confirmedAppointments = appointments.filter((appointment: AppointmentModel) =>
      CONFIRMED_APPOINTMENT_STATUSES.has(normalizeStatus(appointment.status)));

    const mappedAppointments = appointments.map((appointment: AppointmentModel) => ({
      id: appointment.id,
      doctorName: appointment.doctorName,
      specialty: appointment.specialty,
      date: appointment.date,
      time: appointment.time,
      status: appointment.status,
      convenio: appointment.convenio,
      type: appointment.type,
    }));

    if (!confirmedAppointments.length) {
      return reply.send({
        status: 'NO_CONFIRMED_APPOINTMENTS',
        message: 'Paciente reconhecido, mas sem agendamento confirmado para hoje.',
        patient: {
          id: patient.id,
          name: patient.name,
          cpf: maskCpf(patient.cpf),
        },
        appointments: mappedAppointments,
        trust: trust ?? null,
      });
    }

    const { start, end } = getTodayBounds();
    const existingPreAttendances = await prisma.preAttendance.findMany({
      where: {
        branchId,
        patientId: patient.id,
        isActive: true,
        createdAt: {
          gte: start,
          lte: end,
        },
      },
      orderBy: [
        { createdAt: 'desc' },
        { updatedAt: 'desc' },
      ],
    });

    const queue = 'Fila de atendimento';
    const queueType = 'Autorização e Recepção';
    const confirmedAppointmentIds = confirmedAppointments.map((appointment) => String(appointment.id));
    const preSchedulingFlows = confirmedAppointmentIds.length
      ? await prisma.preSchedulingFlow.findMany({
          where: {
            appointmentId: {
              in: confirmedAppointmentIds,
            },
          },
          select: {
            appointmentId: true,
            guideNumber: true,
            preAuthorizedAt: true,
          },
        })
      : [];
    const notes = [
      'Check-in automático por reconhecimento facial.',
      patientName ? `Paciente reconhecido: ${patientName}.` : null,
      trust !== undefined ? `Confiança: ${(trust * 100).toFixed(1)}%.` : null,
    ].filter(Boolean).join(' ');

    const existingPreAttendanceByAppointmentId = new Map<string, PreAttendanceModel>(
      existingPreAttendances
        .filter((item: PreAttendanceModel) => item.appointmentId)
        .map((item: PreAttendanceModel) => [String(item.appointmentId), item]),
    );

    const doctorNames = Array.from(
      new Set(
        confirmedAppointments
          .map((appointment) => String(appointment.doctorName || '').trim())
          .filter(Boolean),
      ),
    );

    const doctors: DoctorQueueLookup[] = doctorNames.length
      ? await prisma.doctor.findMany({
          where: {
            branchId,
            name: {
              in: doctorNames,
              mode: 'insensitive',
            },
          },
          select: { id: true, name: true },
        })
      : [];

    const doctorByNormalizedName = new Map(
      doctors.map((doctor: DoctorQueueLookup) => [doctor.name.trim().toLowerCase(), doctor]),
    );

    const processedPreAttendances: PreAttendanceModel[] = [];

    for (const appointment of confirmedAppointments) {
      const existingPreAttendance = existingPreAttendanceByAppointmentId.get(String(appointment.id));
      const flowForAppointment =
        preSchedulingFlows.find((flow: any) => String(flow.appointmentId) === String(appointment.id)) || null;
      const normalizedPreAttendanceStatus = normalizeStatus(existingPreAttendance?.status);
      const queueStatus = getCheckInQueueStatus(appointment.date, appointment.time);
      const matchedDoctor = doctorByNormalizedName.get(String(appointment.doctorName || '').trim().toLowerCase());
      const resolvedConvenioStatus = (
        normalizeStatus(appointment.authorizationStatus) === 'AUTHORIZED' || Boolean(flowForAppointment?.preAuthorizedAt)
      ) ? 'Autorizado' : null;
      const resolvedConvenioNumber = flowForAppointment?.guideNumber || patient.healthInsuranceNumber || null;
      const agenda = formatAppointmentSummary(appointment);

      const baseData = {
        fullName: patient.name,
        cpf: patient.cpf,
        birthDate: patient.birthDate ? patient.birthDate.toISOString().slice(0, 10) : null,
        appointmentId: appointment.id,
        gender: patient.gender || null,
        phone: patient.phone || patient.cellphone || null,
        email: patient.email || null,
        address: patient.address || null,
        convenio: appointment.convenio || patient.healthInsuranceName || null,
        convenioNumber: resolvedConvenioNumber,
        convenioStatus: resolvedConvenioStatus,
        convenioValidUntil: patient.healthInsuranceExpiry ? patient.healthInsuranceExpiry.toISOString().slice(0, 10) : null,
        queue,
        queueType,
        agenda,
        doctorId: matchedDoctor?.id || null,
        doctorName: matchedDoctor?.name || appointment.doctorName || null,
        notes,
        totem: totem ?? existingPreAttendance?.totem ?? 1,
      };

      if (existingPreAttendance) {
        if (ADVANCED_PRE_ATTENDANCE_STATUSES.has(normalizeStatus(existingPreAttendance.status))) {
          processedPreAttendances.push(existingPreAttendance);
          continue;
        }

        if (!CLOSED_PRE_ATTENDANCE_STATUSES.has(normalizedPreAttendanceStatus)) {
          const updatedPreAttendance = await prisma.preAttendance.update({
            where: { id: existingPreAttendance.id },
            data: {
              ...baseData,
              status: existingPreAttendance.status || queueStatus,
            },
          });

          processedPreAttendances.push(updatedPreAttendance);
          continue;
        }
      }

      const createdPreAttendance = await prisma.preAttendance.create({
        data: {
          branchId,
          patientId: patient.id,
          ...baseData,
          status: queueStatus,
        },
      });

      processedPreAttendances.push(createdPreAttendance);
    }

    const queuedPreAttendances = processedPreAttendances.filter((item: PreAttendanceModel) => {
      const status = normalizeStatus(item.status);
      return status === normalizeStatus('Na fila da recepção')
        || status === normalizeStatus('Atrasado');
    });
    const firstPreAttendance = processedPreAttendances[0] || null;
    const allAlreadyAdvanced = processedPreAttendances.length > 0
      && processedPreAttendances.every((item: PreAttendanceModel) =>
        ADVANCED_PRE_ATTENDANCE_STATUSES.has(normalizeStatus(item.status)));

    return reply.send({
      status: 'QUEUED',
      message: allAlreadyAdvanced
        ? 'Paciente reconhecido. Os agendamentos de hoje já avançaram no fluxo da recepção.'
        : queuedPreAttendances.length > 1
          ? `Check-in realizado com sucesso. ${queuedPreAttendances.length} agendamentos enviados para a fila de atendimento.`
          : 'Check-in realizado com sucesso. Paciente enviado para a fila de atendimento.',
      patient: {
        id: patient.id,
        name: patient.name,
        cpf: patient.cpf,
      },
      appointments: confirmedAppointments.map((appointment: AppointmentModel) => ({
        id: appointment.id,
        doctorName: appointment.doctorName,
        specialty: appointment.specialty,
        date: appointment.date,
        time: appointment.time,
        status: appointment.status,
        convenio: appointment.convenio,
        type: appointment.type,
      })),
      preAttendance: firstPreAttendance ? {
        id: firstPreAttendance.id,
        status: firstPreAttendance.status,
        appointmentId: firstPreAttendance.appointmentId,
        queue: firstPreAttendance.queue,
        queueType: firstPreAttendance.queueType,
        agenda: firstPreAttendance.agenda,
        doctorId: firstPreAttendance.doctorId,
        doctorName: firstPreAttendance.doctorName,
      } : null,
      preAttendances: processedPreAttendances.map((item: PreAttendanceModel) => ({
        id: item.id,
        status: item.status,
        appointmentId: item.appointmentId,
        queue: item.queue,
        queueType: item.queueType,
        agenda: item.agenda,
        doctorId: item.doctorId,
        doctorName: item.doctorName,
      })),
      trust: trust ?? null,
    });
  });
}
