import type { Appointment as AppointmentModel } from '@prisma/client';
import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

const CONFIRMED_APPOINTMENT_STATUSES = new Set(['CONFIRMADO', 'CONFIRMED']);
const CLOSED_PRE_ATTENDANCE_STATUSES = new Set(['FINALIZADO', 'FINALIZADA', 'CANCELADO', 'CANCELADA']);

const normalizeStatus = (value?: string | null) => String(value || '').trim().toUpperCase();
const normalizeCpf = (value?: string | null) => String(value || '').replace(/\D/g, '');

const getTodayDateString = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getTodayBounds = () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const end = new Date();
  end.setHours(23, 59, 59, 999);

  return { start, end };
};

const formatAppointmentSummary = (appointment: {
  time?: string | null;
  specialty?: string | null;
  doctorName?: string | null;
}) => [appointment.time, appointment.specialty, appointment.doctorName].filter(Boolean).join(' • ');

export default async function publicCheckInRoutes(app: FastifyInstance) {
  app.get('/branch/:branchId', {
    schema: {
      summary: 'Get public branch info for kiosk/totem',
      tags: ['PublicCheckIn'],
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

    const branch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: {
        id: true,
        tradeName: true,
        phone: true,
      },
    });

    if (!branch) {
      return reply.code(404).send({ error: 'Branch not found' });
    }

    return branch;
  });

  app.post('/facial', {
    schema: {
      summary: 'Public facial check-in for kiosk/totem',
      tags: ['PublicCheckIn'],
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
        OR: patientLookupConditions,
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
      CONFIRMED_APPOINTMENT_STATUSES.has(normalizeStatus(appointment.status)),
    );

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
          cpf: patient.cpf,
        },
        appointments: mappedAppointments,
        trust: trust ?? null,
      });
    }

    const { start, end } = getTodayBounds();
    const existingPreAttendance = await prisma.preAttendance.findFirst({
      where: {
        branchId,
        patientId: patient.id,
        isActive: true,
        createdAt: {
          gte: start,
          lte: end,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const queue = 'Fila de atendimento';
    const queueType = 'Autorização e Recepção';
    const agenda = confirmedAppointments.map(formatAppointmentSummary).filter(Boolean).join(' | ');
    const primaryAppointment = confirmedAppointments[0];
    const primaryDoctorName = String(primaryAppointment?.doctorName || '').trim();
    const matchedDoctor = primaryDoctorName
      ? await prisma.doctor.findFirst({
          where: {
            branchId,
            name: {
              equals: primaryDoctorName,
              mode: 'insensitive',
            },
          },
          select: { id: true, name: true },
        })
      : null;
    const resolvedDoctorId = matchedDoctor?.id || null;
    const resolvedDoctorName = matchedDoctor?.name || primaryDoctorName || null;
    const notes = [
      'Check-in automático por reconhecimento facial.',
      patientName ? `Paciente reconhecido: ${patientName}.` : null,
      trust !== undefined ? `Confiança: ${(trust * 100).toFixed(1)}%.` : null,
    ].filter(Boolean).join(' ');

    let preAttendance = existingPreAttendance;

    if (existingPreAttendance && !CLOSED_PRE_ATTENDANCE_STATUSES.has(normalizeStatus(existingPreAttendance.status))) {
      preAttendance = await prisma.preAttendance.update({
        where: { id: existingPreAttendance.id },
        data: {
          fullName: patient.name,
          cpf: patient.cpf,
          birthDate: patient.birthDate ? patient.birthDate.toISOString().slice(0, 10) : null,
          gender: patient.gender || null,
          phone: patient.phone || patient.cellphone || null,
          email: patient.email || null,
          address: patient.address || null,
          convenio: confirmedAppointments[0]?.convenio || patient.healthInsuranceName || null,
          convenioNumber: patient.healthInsuranceNumber || null,
          convenioValidUntil: patient.healthInsuranceExpiry ? patient.healthInsuranceExpiry.toISOString().slice(0, 10) : null,
          status: 'Na fila da recepção',
          queue,
          queueType,
          agenda,
          doctorId: resolvedDoctorId,
          doctorName: resolvedDoctorName,
          notes,
          totem: totem ?? existingPreAttendance.totem ?? 1,
        },
      });
    } else {
      preAttendance = await prisma.preAttendance.create({
        data: {
          branchId,
          patientId: patient.id,
          fullName: patient.name,
          cpf: patient.cpf,
          birthDate: patient.birthDate ? patient.birthDate.toISOString().slice(0, 10) : null,
          gender: patient.gender || null,
          phone: patient.phone || patient.cellphone || null,
          email: patient.email || null,
          address: patient.address || null,
          convenio: confirmedAppointments[0]?.convenio || patient.healthInsuranceName || null,
          convenioNumber: patient.healthInsuranceNumber || null,
          convenioValidUntil: patient.healthInsuranceExpiry ? patient.healthInsuranceExpiry.toISOString().slice(0, 10) : null,
          status: 'Na fila da recepção',
          queue,
          queueType,
          agenda,
          doctorId: resolvedDoctorId,
          doctorName: resolvedDoctorName,
          notes,
          totem: totem ?? 1,
        },
      });
    }

    return reply.send({
      status: 'QUEUED',
      message: 'Check-in realizado com sucesso. Paciente enviado para a fila de atendimento.',
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
      preAttendance: {
        id: preAttendance.id,
        status: preAttendance.status,
        queue: preAttendance.queue,
        queueType: preAttendance.queueType,
        agenda: preAttendance.agenda,
        doctorId: preAttendance.doctorId,
        doctorName: preAttendance.doctorName,
      },
      trust: trust ?? null,
    });
  });
}
