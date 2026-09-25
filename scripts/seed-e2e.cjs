/*
 * Deterministic fixture for the Playwright suite.
 *
 * This script is intentionally separate from the application seed. It only
 * runs against the disposable database from docker-compose.e2e.yml.
 */
require('dotenv/config');

const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { runSeed } = require('../src/lib/seed.js');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for the E2E seed');

const pool = new Pool({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const E2E_PASSWORD = 'E2e!Test123';
const WEEKDAYS = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];

const dateOnly = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

async function main() {
  await runSeed({ client: prisma, logger: { log() {} } });

  const company = await prisma.company.create({
    data: {
      cnpj: '00000000000191',
      legalName: 'Saudy E2E Tecnologia Clínica LTDA',
      tradeName: 'Saudy E2E Clínica',
      address: 'Rua dos Testes, 100',
      phone: '1130000000',
      module_type: 'padrao',
    },
  });

  const branch = await prisma.branch.create({
    data: {
      companyId: company.id,
      tradeName: 'Unidade E2E Centro',
      address: 'Rua dos Testes, 100',
      phone: '1130000000',
      isMatriz: true,
    },
  });

  const sector = await prisma.sector.create({
    data: {
      branchId: branch.id,
      name: 'Recepção E2E',
      description: 'Setor exclusivo para os testes automatizados',
    },
  });

  const modality = await prisma.modalidade.create({
    data: {
      branchId: branch.id,
      name: 'Consulta E2E',
      description: 'Modalidade utilizada pelos testes automatizados',
    },
  });

  const specialty = await prisma.especialidade.create({
    data: {
      branchId: branch.id,
      modalidadeId: modality.id,
      name: 'Clínica E2E',
    },
  });

  const secondSpecialty = await prisma.especialidade.create({
    data: {
      branchId: branch.id,
      modalidadeId: modality.id,
      name: 'Fisioterapia E2E',
    },
  });

  const room = await prisma.sector.create({
    data: {
      branchId: branch.id,
      name: 'Sala E2E 1',
      description: '[SALA] Sala exclusiva para os testes automatizados',
      modalidadeId: modality.id,
      especialidadeId: specialty.id,
      especialidadeIds: [specialty.id],
      workingDays: WEEKDAYS,
      workingHoursStart: '08:00',
      workingHoursEnd: '18:00',
      capacity: 1,
    },
  });

  // Keep enough rooms in the disposable fixture to exercise the weekly room-map scroll.
  for (let roomNumber = 2; roomNumber <= 12; roomNumber += 1) {
    await prisma.sector.create({
      data: {
        branchId: branch.id,
        name: `Sala E2E ${roomNumber}`,
        description: `[SALA] Sala ${roomNumber} exclusiva para os testes automatizados`,
        modalidadeId: modality.id,
        especialidadeId: specialty.id,
        especialidadeIds: [specialty.id],
        workingDays: WEEKDAYS,
        workingHoursStart: '08:00',
        workingHoursEnd: '18:00',
        capacity: 1,
      },
    });
  }

  const secondSpecialtyRoom = await prisma.sector.create({
    data: {
      branchId: branch.id,
      name: 'Sala E2E Fisioterapia',
      description: '[SALA] Sala exclusiva para a segunda especialidade E2E',
      modalidadeId: modality.id,
      especialidadeId: secondSpecialty.id,
      especialidadeIds: [secondSpecialty.id],
      workingDays: WEEKDAYS,
      workingHoursStart: '08:00',
      workingHoursEnd: '18:00',
      capacity: 1,
    },
  });

  const combinedRoom = await prisma.sector.create({
    data: {
      branchId: branch.id,
      name: 'Sala E2E Multiespecialidade',
      description: '[SALA] Sala compatível com as especialidades E2E',
      modalidadeId: modality.id,
      especialidadeId: specialty.id,
      especialidadeIds: [specialty.id, secondSpecialty.id],
      workingDays: WEEKDAYS,
      workingHoursStart: '08:00',
      workingHoursEnd: '18:00',
      capacity: 1,
    },
  });

  const procedure = await prisma.procedure.create({
    data: {
      branchId: branch.id,
      branchIds: [branch.id],
      modalidadeId: modality.id,
      especialidadeId: specialty.id,
      name: 'Consulta E2E',
      appointmentType: 'CONSULTA',
      durationMinutes: 30,
      modalities: ['Presencial'],
    },
  });

  const secondProcedure = await prisma.procedure.create({
    data: {
      branchId: branch.id,
      branchIds: [branch.id],
      modalidadeId: modality.id,
      especialidadeId: specialty.id,
      name: 'Avaliação E2E',
      appointmentType: 'CONSULTA',
      durationMinutes: 30,
      modalities: ['Presencial'],
    },
  });

  const examProcedure = await prisma.procedure.create({
    data: {
      branchId: branch.id,
      branchIds: [branch.id],
      modalidadeId: modality.id,
      especialidadeId: specialty.id,
      name: 'Exame E2E',
      appointmentType: 'EXAME',
      durationMinutes: 30,
      modalities: ['Presencial'],
    },
  });

  const mobileExamProcedure = await prisma.procedure.create({
    data: {
      branchId: branch.id,
      branchIds: [branch.id],
      modalidadeId: modality.id,
      especialidadeId: specialty.id,
      name: 'Exame E2E Mobile',
      appointmentType: 'EXAME',
      durationMinutes: 30,
      modalities: ['Presencial'],
    },
  });

  const teaProcedure = await prisma.procedure.create({
    data: {
      branchId: branch.id,
      branchIds: [branch.id],
      modalidadeId: modality.id,
      especialidadeId: specialty.id,
      name: 'Terapia E2E',
      appointmentType: 'CONSULTA_TERAPIAS',
      durationMinutes: 30,
      modalities: ['Presencial'],
    },
  });

  const doctor = await prisma.doctor.create({
    data: {
      branchId: branch.id,
      branchIds: [branch.id],
      crmType: 'CRM',
      crm: 'E2E001',
      crmState: 'SP',
      name: 'Dra. Profissional E2E',
      email: 'profissional.e2e@saudy.test',
      phone: '11900000000',
      birthDate: new Date('1985-05-20T12:00:00.000Z'),
      gender: 'FEMALE',
      cpf: '98765432100',
      specialty: procedure.name,
      specialties: [procedure.name, secondProcedure.name],
      especialidadeGroups: JSON.stringify([{
        modalidadeId: modality.id,
        especialidadeId: specialty.id,
        especialidadeIds: [specialty.id, secondSpecialty.id],
        registrationType: 'CRM',
        registrationNumber: 'E2E001',
        registrationState: 'SP',
      }]),
      workingDays: [],
      workingSchedules: '[]',
      isActive: true,
    },
  });

  const secondDoctor = await prisma.doctor.create({
    data: {
      branchId: branch.id,
      branchIds: [branch.id],
      crmType: 'CRM',
      crm: 'E2E002',
      crmState: 'SP',
      name: 'Dr. Segundo Profissional E2E',
      email: 'segundo.profissional.e2e@saudy.test',
      phone: '11900000001',
      birthDate: new Date('1987-08-15T12:00:00.000Z'),
      gender: 'MALE',
      cpf: '98765432101',
      specialty: secondProcedure.name,
      specialties: [secondProcedure.name],
      especialidadeGroups: JSON.stringify([{
        modalidadeId: modality.id,
        especialidadeId: specialty.id,
        especialidadeIds: [specialty.id],
        registrationType: 'CRM',
        registrationNumber: 'E2E002',
        registrationState: 'SP',
      }]),
      workingDays: [],
      workingSchedules: '[]',
      isActive: true,
    },
  });

  await prisma.procedureDoctor.create({
    data: {
      procedureId: procedure.id,
      doctorId: doctor.id,
      doctorName: doctor.name,
      durationMinutes: procedure.durationMinutes,
      branchIds: [branch.id],
    },
  });

  await prisma.procedureDoctor.create({
    data: {
      procedureId: secondProcedure.id,
      doctorId: secondDoctor.id,
      doctorName: secondDoctor.name,
      durationMinutes: secondProcedure.durationMinutes,
      branchIds: [branch.id],
    },
  });

  await prisma.procedureDoctor.create({
    data: {
      procedureId: teaProcedure.id,
      doctorId: doctor.id,
      doctorName: doctor.name,
      durationMinutes: teaProcedure.durationMinutes,
      branchIds: [branch.id],
    },
  });

  const targetDate = new Date();
  targetDate.setHours(12, 0, 0, 0);
  targetDate.setDate(targetDate.getDate() + 1);
  const targetDateIso = dateOnly(targetDate);
  const mobileTargetDate = new Date(targetDate);
  mobileTargetDate.setDate(mobileTargetDate.getDate() + 7);
  const mobileTargetDateIso = dateOnly(mobileTargetDate);

  const agenda = await prisma.agenda.create({
    data: {
      branchId: branch.id,
      doctorId: doctor.id,
      weekday: WEEKDAYS[targetDate.getDay()],
      shiftStart: '09:00',
      shiftEnd: '17:00',
      especialidadeId: specialty.id,
      especialidadeIds: [specialty.id],
      roomId: room.id,
      status: 'ATIVA',
      createdByName: 'E2E seed',
    },
  });

  const secondAgenda = await prisma.agenda.create({
    data: {
      branchId: branch.id,
      doctorId: secondDoctor.id,
      weekday: WEEKDAYS[targetDate.getDay()],
      shiftStart: '09:00',
      shiftEnd: '17:00',
      especialidadeId: specialty.id,
      especialidadeIds: [specialty.id],
      roomId: room.id,
      status: 'ATIVA',
      createdByName: 'E2E seed',
    },
  });

  const insurance = await prisma.insurance.create({
    data: {
      branchId: branch.id,
      name: 'Particular E2E',
      code: 'E2E-PARTICULAR',
      isActive: true,
    },
  });

  await prisma.branchSettings.create({
    data: {
      branchId: branch.id,
      requireFacialForPatientRegistration: false,
      requireFacialForReportDelivery: false,
      doctorCanScheduleExamFromConsultation: true,
    },
  });

  const patient = await prisma.patient.create({
    data: {
      branchId: branch.id,
      companyId: company.id,
      name: 'Paciente E2E',
      cellphone: '11988887777',
      phone: '1130000000',
      birthDate: new Date('1990-04-10T12:00:00.000Z'),
      gender: 'OTHER',
      cpf: '12345678909',
      hasHealthInsurance: false,
      isActive: true,
    },
  });

  const mobilePatient = await prisma.patient.create({
    data: {
      branchId: branch.id,
      companyId: company.id,
      name: 'Paciente Mobile E2E',
      cellphone: '11988887778',
      phone: '1130000000',
      birthDate: new Date('1992-06-15T12:00:00.000Z'),
      gender: 'OTHER',
      cpf: '22345678909',
      hasHealthInsurance: false,
      isActive: true,
    },
  });

  const telePatient = await prisma.patient.create({
    data: {
      branchId: branch.id,
      companyId: company.id,
      name: 'Paciente Tele E2E',
      cellphone: '11988887779',
      phone: '1130000000',
      birthDate: new Date('1988-02-20T12:00:00.000Z'),
      gender: 'OTHER',
      cpf: '32345678917',
      hasHealthInsurance: false,
      isActive: true,
    },
  });

  const mobileTelePatient = await prisma.patient.create({
    data: {
      branchId: branch.id,
      companyId: company.id,
      name: 'Paciente Tele E2E Mobile',
      cellphone: '11988887780',
      phone: '1130000000',
      birthDate: new Date('1989-03-25T12:00:00.000Z'),
      gender: 'OTHER',
      cpf: '42345678925',
      hasHealthInsurance: false,
      isActive: true,
    },
  });

  const historyPatient = await prisma.patient.create({
    data: {
      branchId: branch.id,
      companyId: company.id,
      name: 'Paciente Histórico E2E',
      cellphone: '11988887781',
      phone: '1130000000',
      birthDate: new Date('1991-07-12T12:00:00.000Z'),
      gender: 'OTHER',
      cpf: '52345678933',
      hasHealthInsurance: false,
      isActive: true,
    },
  });

  const teaPatients = [patient, mobilePatient];
  for (const teaPatient of teaPatients) {
    const teaProfile = await prisma.teaProfile.create({
      data: {
        patientId: teaPatient.id,
        supportLevel: 'Moderado',
        therapeuticGoals: 'Fixture E2E para validar a jornada de pré-reserva.',
        isActive: true,
      },
    });

    const pit = await prisma.teaPit.create({
      data: {
        teaProfileId: teaProfile.id,
        title: 'PIT E2E',
        startDate: new Date(`${targetDateIso}T12:00:00.000Z`),
        status: 'Ativo',
        notes: 'PIT determinístico da suíte E2E.',
      },
    });

    await prisma.teaPitTherapy.create({
      data: {
        pitId: pit.id,
        procedureId: teaProcedure.id,
        therapyType: teaProcedure.name,
        weeklyFrequency: 1,
        preferredWeekdays: [WEEKDAYS[targetDate.getDay()]],
          preferredShift: 'TARDE',
        durationMinutes: teaProcedure.durationMinutes,
        professionalDoctorId: doctor.id,
        professional: doctor.name,
        isActive: true,
      },
    });
  }

  const teleNow = new Date();
  teleNow.setMinutes(teleNow.getMinutes() - 30);
  const teleDateIso = dateOnly(teleNow);
  const teleTime = `${String(teleNow.getHours()).padStart(2, '0')}:${String(teleNow.getMinutes()).padStart(2, '0')}`;
  const telePatients = [telePatient, mobileTelePatient];
  const teleAppointments = [];

  for (const [index, telePatientItem] of telePatients.entries()) {
    const teleAppointment = await prisma.appointment.create({
      data: {
        branchId: branch.id,
        patientId: telePatientItem.id,
        patientName: telePatientItem.name,
        patientCpf: telePatientItem.cpf,
        doctorId: doctor.id,
        doctorName: doctor.name,
        agendaId: agenda.id,
        roomId: room.id,
        specialty: procedure.name,
        convenio: insurance.name,
        date: teleDateIso,
        time: teleTime,
        durationMinutes: procedure.durationMinutes,
        type: 'CONSULTA',
        status: 'CONFIRMADO',
        authorizationStatus: 'AUTHORIZED',
        observations: '[MODALIDADE: TELECONSULTA] Fixture E2E',
      },
    });

    await prisma.preSchedulingFlow.create({
      data: {
        branchId: branch.id,
        appointmentId: teleAppointment.id,
        patientId: telePatientItem.id,
        patientName: telePatientItem.name,
        patientCpf: telePatientItem.cpf,
        patientPhone: telePatientItem.cellphone,
        source: 'COMMON',
        status: 'COMPLETED',
        preAuthorizedAt: new Date(),
        completedAt: new Date(),
        publicToken: `e2e-public-token-${index + 1}`,
      },
    });

    await prisma.consultation.create({
      data: {
        branchId: branch.id,
        doctorId: doctor.id,
        appointmentId: teleAppointment.id,
        doctorName: doctor.name,
        patientName: telePatientItem.name,
        convenio: insurance.name,
        scheduledFor: `${teleDateIso} ${teleTime}`,
        queueType: 'Fila clínica',
        queue: 'Aguardando atendimento',
        mainComplaint: 'Teleconsulta E2E',
      },
    });

    teleAppointments.push(teleAppointment);
  }

  const consultationAppointment = await prisma.appointment.create({
    data: {
      branchId: branch.id,
      patientId: patient.id,
      patientName: patient.name,
      patientCpf: patient.cpf,
      doctorId: doctor.id,
      doctorName: doctor.name,
      agendaId: agenda.id,
      roomId: room.id,
      specialty: procedure.name,
      convenio: insurance.name,
      date: targetDateIso,
      time: '11:00',
      durationMinutes: procedure.durationMinutes,
      type: 'CONSULTA',
      status: 'CONFIRMADO',
      authorizationStatus: 'AUTHORIZED',
    },
  });

  await prisma.consultation.create({
    data: {
      branchId: branch.id,
      doctorId: doctor.id,
      appointmentId: consultationAppointment.id,
      doctorName: doctor.name,
      patientName: patient.name,
      convenio: insurance.name,
      scheduledFor: `${targetDateIso} 11:00`,
      queueType: 'Fila clínica',
      queue: 'Aguardando atendimento',
      mainComplaint: 'Avaliação clínica E2E',
    },
  });

  await prisma.preAttendance.create({
    data: {
      branchId: branch.id,
      patientId: patient.id,
      appointmentId: consultationAppointment.id,
      fullName: patient.name,
      cpf: patient.cpf,
      birthDate: '1990-04-10',
      gender: 'MALE',
      phone: patient.cellphone,
      email: patient.email,
      convenio: 'Particular E2E',
      status: 'Em atendimento na recepção',
      queue: 'Recepção E2E',
      queueType: 'Autorização e Recepção',
      agenda: `${targetDateIso} 11:00 • Consulta E2E`,
      doctorId: doctor.id,
      doctorName: doctor.name,
    },
  });

  const mobileConsultationAppointment = await prisma.appointment.create({
    data: {
      branchId: branch.id,
      patientId: mobilePatient.id,
      patientName: mobilePatient.name,
      patientCpf: mobilePatient.cpf,
      doctorId: doctor.id,
      doctorName: doctor.name,
      agendaId: agenda.id,
      roomId: room.id,
      specialty: procedure.name,
      convenio: insurance.name,
      date: targetDateIso,
      time: '11:30',
      durationMinutes: procedure.durationMinutes,
      type: 'CONSULTA',
      status: 'CONFIRMADO',
      authorizationStatus: 'AUTHORIZED',
    },
  });

  await prisma.consultation.create({
    data: {
      branchId: branch.id,
      doctorId: doctor.id,
      appointmentId: mobileConsultationAppointment.id,
      doctorName: doctor.name,
      patientName: mobilePatient.name,
      convenio: insurance.name,
      scheduledFor: `${targetDateIso} 11:30`,
      queueType: 'Fila clínica',
      queue: 'Aguardando atendimento',
      mainComplaint: 'Avaliação clínica E2E Mobile',
    },
  });

  await prisma.preAttendance.create({
    data: {
      branchId: branch.id,
      patientId: mobilePatient.id,
      appointmentId: mobileConsultationAppointment.id,
      fullName: mobilePatient.name,
      cpf: mobilePatient.cpf,
      birthDate: '1992-06-15',
      gender: 'OTHER',
      phone: mobilePatient.cellphone,
      email: mobilePatient.email,
      convenio: 'Particular E2E',
      status: 'Em atendimento na recepção',
      queue: 'Recepção E2E',
      queueType: 'Autorização e Recepção',
      agenda: `${targetDateIso} 11:30 • Consulta E2E`,
      doctorId: doctor.id,
      doctorName: doctor.name,
    },
  });

  const historyAppointment = await prisma.appointment.create({
    data: {
      branchId: branch.id,
      patientId: historyPatient.id,
      patientName: historyPatient.name,
      patientCpf: historyPatient.cpf,
      doctorId: doctor.id,
      doctorName: doctor.name,
      agendaId: agenda.id,
      roomId: room.id,
      specialty: procedure.name,
      convenio: insurance.name,
      date: targetDateIso,
      time: '08:30',
      durationMinutes: procedure.durationMinutes,
      type: 'CONSULTA',
      status: 'REALIZADO',
      authorizationStatus: 'AUTHORIZED',
    },
  });

  const historyConsultation = await prisma.consultation.create({
    data: {
      branchId: branch.id,
      doctorId: doctor.id,
      appointmentId: historyAppointment.id,
      doctorName: doctor.name,
      patientName: historyPatient.name,
      convenio: insurance.name,
      scheduledFor: `${targetDateIso} 08:30`,
      queueType: 'Fila clínica',
      queue: 'Atendimento concluído',
      mainComplaint: 'Registro histórico preparado para a jornada E2E.',
    },
  });

  await prisma.medicalRecord.create({
    data: {
      patientId: historyPatient.id,
      consultationId: historyConsultation.id,
      doctorId: doctor.id,
      chiefComplaint: 'Queixa registrada no prontuário histórico E2E.',
      diagnosis: 'Avaliação clínica de acompanhamento E2E.',
      treatment: 'Manter acompanhamento conforme orientação clínica.',
      notes: 'Registro preparado para validar filtros e detalhes do histórico.',
      heartRate: 72,
      temperature: 36.5,
      oxygenSaturation: 98,
    },
  });

  const examAppointment = await prisma.appointment.create({
    data: {
      branchId: branch.id,
      patientId: patient.id,
      patientName: patient.name,
      patientCpf: patient.cpf,
      doctorId: doctor.id,
      doctorName: doctor.name,
      agendaId: agenda.id,
      roomId: room.id,
      specialty: examProcedure.name,
      convenio: insurance.name,
      date: targetDateIso,
      time: '13:00',
      durationMinutes: examProcedure.durationMinutes,
      type: 'EXAME',
      status: 'CONFIRMADO',
      authorizationStatus: 'AUTHORIZED',
    },
  });

  const nursingTemplate = await prisma.procedureNursingTemplate.create({
    data: {
      branchId: branch.id,
      procedureId: examProcedure.id,
      name: 'Triagem E2E',
      description: 'Template de triagem para os testes automatizados',
    },
  });

  await prisma.consultation.create({
    data: {
      branchId: branch.id,
      doctorId: doctor.id,
      appointmentId: examAppointment.id,
      doctorName: doctor.name,
      patientName: patient.name,
      convenio: insurance.name,
      scheduledFor: `${targetDateIso} 13:00`,
      queueType: 'Fila clínica',
      queue: 'Aguardando triagem',
    },
  });

  const mobileExamAppointment = await prisma.appointment.create({
    data: {
      branchId: branch.id,
      patientId: mobilePatient.id,
      patientName: mobilePatient.name,
      patientCpf: mobilePatient.cpf,
      doctorId: doctor.id,
      doctorName: doctor.name,
      agendaId: agenda.id,
      roomId: room.id,
      specialty: examProcedure.name,
      convenio: insurance.name,
      date: targetDateIso,
      time: '13:30',
      durationMinutes: examProcedure.durationMinutes,
      type: 'EXAME',
      status: 'CONFIRMADO',
      authorizationStatus: 'AUTHORIZED',
    },
  });

  await prisma.consultation.create({
    data: {
      branchId: branch.id,
      doctorId: doctor.id,
      appointmentId: mobileExamAppointment.id,
      doctorName: doctor.name,
      patientName: mobilePatient.name,
      convenio: insurance.name,
      scheduledFor: `${targetDateIso} 13:30`,
      queueType: 'Fila clínica',
      queue: 'Aguardando triagem',
    },
  });

  const examReport = await prisma.report.create({
    data: {
      branchId: branch.id,
      appointmentId: examAppointment.id,
      patientName: patient.name,
      cpf: patient.cpf,
      birthDate: '1990-04-10',
      requestingDoctor: doctor.name,
      status: 'rascunho',
      exam: examProcedure.name,
      scheduledFor: `${targetDateIso} 13:00`,
      observation: 'Laudo preparado para validação E2E.',
    },
  });

  const modules = await prisma.module.findMany({ select: { id: true } });
  const access = await prisma.access.create({
    data: {
      description: 'Acesso total E2E',
      isTemplate: false,
      modules: { connect: modules.map(({ id }) => ({ id })) },
    },
  });

  const password = await bcrypt.hash(E2E_PASSWORD, 10);
  const user = await prisma.user.create({
    data: {
      sectorId: sector.id,
      name: 'Usuário E2E',
      birthDate: new Date('1990-01-01T12:00:00.000Z'),
      email: 'e2e@saudy.test',
      cpf: '11122233344',
      password,
      phone: '11999999999',
      address: 'Rua dos Testes, 100',
      accesses: { connect: [{ id: access.id }] },
    },
  });

  const fixture = {
    loginEmail: user.email,
    branchId: branch.id,
    patientName: patient.name,
    patientCpf: patient.cpf,
    mobilePatientName: mobilePatient.name,
    historyPatientName: historyPatient.name,
    telePatientName: telePatient.name,
    mobileTelePatientName: mobileTelePatient.name,
    branchName: branch.tradeName,
    procedureName: procedure.name,
    secondProcedureName: secondProcedure.name,
    examProcedureName: examProcedure.name,
    mobileExamProcedureName: mobileExamProcedure.name,
    teaProcedureName: teaProcedure.name,
    specialtyName: specialty.name,
    secondSpecialtyName: secondSpecialty.name,
    doctorName: doctor.name,
    secondDoctorName: secondDoctor.name,
    insuranceName: insurance.name,
    roomName: room.name,
    secondSpecialtyRoomName: secondSpecialtyRoom.name,
    combinedRoomName: combinedRoom.name,
    agendaId: agenda.id,
    secondAgendaId: secondAgenda.id,
    consultationAppointmentId: consultationAppointment.id,
    historyAppointmentId: historyAppointment.id,
    examAppointmentId: examAppointment.id,
    examReportId: examReport.id,
    nursingTemplateId: nursingTemplate.id,
    teleAppointmentId: teleAppointments[0].id,
    mobileTeleAppointmentId: teleAppointments[1].id,
    targetDate: targetDateIso,
    mobileTargetDate: mobileTargetDateIso,
    targetWeekday: agenda.weekday,
    apiBaseUrl: 'http://127.0.0.1:3301',
  };

  const fixturePath = process.env.E2E_FIXTURE_PATH;
  if (fixturePath) {
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  }

  console.log(`E2E fixture ready for ${targetDateIso} (${agenda.weekday})`);
}

main()
  .catch((error) => {
    console.error('E2E seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
