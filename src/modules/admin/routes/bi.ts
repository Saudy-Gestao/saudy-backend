import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

require('dotenv').config();
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const toNumber = (value: unknown) => {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
};

const normalizeStatus = (value: unknown) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toUpperCase();

const isDoneAppointmentStatus = (status: unknown) => {
  const normalized = normalizeStatus(status);
  return ['ATENDIDO', 'ATENDIDA', 'FINALIZADO', 'FINALIZADA', 'CONCLUIDO', 'CONCLUIDA', 'REALIZADO', 'REALIZADA']
    .some((token) => normalized.includes(token));
};

const isCanceledStatus = (status: unknown) => {
  const normalized = normalizeStatus(status);
  return normalized.includes('CANCEL') || normalized.includes('DESMARC');
};

const isPendingAppointmentStatus = (status: unknown) => {
  const normalized = normalizeStatus(status);
  return !normalized || ['PENDENTE', 'AGENDADO', 'CONFIRMADO', 'WAITING', 'PENDING'].some((token) => normalized.includes(token));
};

const isRevenueEntry = (entry: any) => {
  const normalized = normalizeStatus(entry?.type || entry?.category);
  return normalized.includes('RECEITA') || normalized.includes('ENTRADA') || normalized.includes('CREDIT') || normalized === 'INCOME';
};

const isExpenseEntry = (entry: any) => {
  const normalized = normalizeStatus(entry?.type || entry?.category);
  return normalized.includes('DESPESA') || normalized.includes('SAIDA') || normalized.includes('DEBIT') || normalized === 'EXPENSE';
};

const formatDateKey = (date: Date) => date.toISOString().slice(0, 10);

const parseDateBoundary = (value: unknown, fallback: Date, endOfDay = false) => {
  const raw = String(value || '').trim();
  if (!raw) return fallback;

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    return new Date(Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 999 : 0,
    ));
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
};

const addDays = (date: Date, days: number) => {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
};

const dateLabel = (dateKey: string) => {
  const [, month, day] = dateKey.split('-');
  return `${day}/${month}`;
};

const timeToMinutes = (value?: string | null) => {
  const match = /^(\d{2}):(\d{2})/.exec(String(value || '').trim());
  if (!match) return null;
  const [, hour, minute] = match;
  return Number(hour) * 60 + Number(minute);
};

const minutesToHourLabel = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:00`;

const appointmentDuration = (value: unknown) => {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 30;
};

const dateRangeKeys = (startDate: Date, endDate: Date) => {
  const keys: string[] = [];
  const maxDays = Math.min(45, Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1));
  const totalDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1);
  const step = Math.max(1, Math.floor(totalDays / maxDays));

  for (let index = 0; index < totalDays && keys.length < maxDays; index += step) {
    keys.push(formatDateKey(addDays(startDate, index)));
  }

  return keys;
};

const getLoggedContext = async (requestUserId: string) => {
  const loggedUser = await prisma.user.findUnique({
    where: { id: requestUserId },
    include: {
      sector: {
        include: {
          branch: {
            include: {
              company: true,
            },
          },
        },
      },
      accesses: {
        include: {
          modules: true,
        },
      },
    },
  });

  const branch = loggedUser?.sector?.branch;
  const moduleNames = (loggedUser?.accesses || []).flatMap((access: any) => (access.modules || []).map((module: any) => module.name));
  const hasBiAccess = Boolean(loggedUser?.isAdmHubOnly) || moduleNames.includes('bi-gestao');

  return {
    user: loggedUser,
    companyId: branch?.companyId || null,
    branchId: branch?.id || null,
    hasBiAccess,
  };
};

const biCommonQuerystringSchema = {
  type: 'object',
  properties: {
    startDate: { type: 'string' },
    endDate: { type: 'string' },
    branchId: { type: 'string' },
    sectorId: { type: 'string' },
    doctorId: { type: 'string' },
    insuranceId: { type: 'string' },
    procedureId: { type: 'string' },
  },
};

export default async function biRoutes(app: FastifyInstance) {
  app.get('/overview', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'BI management overview',
      tags: ['BI'],
      security: [{ bearerAuth: [] }],
      querystring: biCommonQuerystringSchema,
    },
  }, async (request, reply) => {
    const requestUserId = (request.user as any).id as string;
    const context = await getLoggedContext(requestUserId);

    if (!context.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    if (!context.hasBiAccess) {
      return reply.code(403).send({ error: 'User does not have BI access' });
    }

    const query = request.query as any;
    const now = new Date();
    const defaultStart = addDays(now, -29);
    const startDate = parseDateBoundary(query.startDate, defaultStart);
    const endDate = parseDateBoundary(query.endDate, now, true);
    const branchId = String(query.branchId || context.branchId || '').trim();
    const appointmentStartKey = formatDateKey(startDate);
    const appointmentEndKey = formatDateKey(endDate);

    const branchWhere = branchId ? { branchId } : {};
    const appointmentWhere = {
      ...branchWhere,
      isActive: true,
      date: {
        gte: appointmentStartKey,
        lte: appointmentEndKey,
      },
    };
    const createdAtWhere = {
      gte: startDate,
      lte: endDate,
    };

    const [
      appointments,
      preSchedulingCount,
      receptionCount,
      consultationsCount,
      reports,
      worklistPendingCount,
      authorizationsPending,
      authorizationsDenied,
      financeEntries,
      invoices,
      tissBatches,
      inventoryItems,
      activeTeaProfiles,
      teaPendingReservations,
    ] = await Promise.all([
      prisma.appointment.findMany({
        where: appointmentWhere,
        select: {
          id: true,
          date: true,
          status: true,
          specialty: true,
          type: true,
          convenio: true,
        },
      }),
      prisma.preSchedulingFlow.count({
        where: {
          appointment: appointmentWhere,
        },
      }),
      prisma.preAttendance.count({
        where: {
          ...branchWhere,
          createdAt: createdAtWhere,
        },
      }),
      prisma.consultation.count({
        where: {
          ...branchWhere,
          createdAt: createdAtWhere,
          isActive: true,
        },
      }),
      prisma.report.findMany({
        where: {
          ...branchWhere,
          isActive: true,
          createdAt: createdAtWhere,
        },
        select: {
          id: true,
          status: true,
          exam: true,
          issuerSignedAt: true,
          reviewerSignedAt: true,
          createdAt: true,
        },
      }),
      prisma.reportWorklistItem.count({
        where: {
          ...branchWhere,
          isActive: true,
          laudos: {
            none: {
              isActive: true,
            },
          },
        },
      }),
      prisma.appointment.count({
        where: {
          ...appointmentWhere,
          authorizationStatus: 'PENDING',
        },
      }),
      prisma.appointment.count({
        where: {
          ...appointmentWhere,
          authorizationStatus: 'DENIED',
        },
      }),
      prisma.financeEntry.findMany({
        where: {
          isActive: true,
          OR: [
            { dueDate: createdAtWhere },
            { createdAt: createdAtWhere },
          ],
        },
        select: {
          id: true,
          type: true,
          category: true,
          value: true,
          discount: true,
          total: true,
          status: true,
          dueDate: true,
          createdAt: true,
        },
      }),
      prisma.invoice.findMany({
        where: {
          isActive: true,
          issuedAt: createdAtWhere,
        },
        select: {
          id: true,
          status: true,
          convention: true,
          total: true,
          value: true,
          issuedAt: true,
        },
      }),
      prisma.tissBatch.findMany({
        where: {
          isActive: true,
          createdAt: createdAtWhere,
        },
        include: {
          items: {
            where: { isActive: true },
            select: {
              glosaValue: true,
              returnStatus: true,
              status: true,
            },
          },
        },
      }),
      prisma.inventoryItem.findMany({
        where: {
          isActive: true,
        },
        select: {
          id: true,
          quantity: true,
          minQuantity: true,
          status: true,
          unitPrice: true,
        },
      }),
      prisma.teaProfile.count({
        where: {
          isActive: true,
          patient: branchId ? { branchId } : undefined,
        },
      }),
      prisma.teaPreReservation.count({
        where: {
          status: {
            in: ['PENDING_SCHEDULING', 'PROPOSED', 'RESERVED', 'PENDING_AUTHORIZATION'],
          },
          createdAt: createdAtWhere,
          patient: branchId ? { branchId } : undefined,
        },
      }),
    ]);

    const realizedAppointments = appointments.filter((item: any) => isDoneAppointmentStatus(item.status)).length;
    const canceledAppointments = appointments.filter((item: any) => isCanceledStatus(item.status)).length;
    const pendingAppointments = appointments.filter((item: any) => isPendingAppointmentStatus(item.status)).length;
    const pendingReports = reports.filter((item: any) => {
      const status = normalizeStatus(item.status);
      return !status || ['RASCUNHO', 'PENDENTE', 'DRAFT', 'REVIEW', 'REVISAO'].some((token) => status.includes(token));
    }).length + worklistPendingCount;
    const signedReports = reports.filter((item: any) => item.issuerSignedAt || item.reviewerSignedAt || normalizeStatus(item.status).includes('ASSIN')).length;

    const revenue = financeEntries.filter(isRevenueEntry).reduce((sum: number, entry: any) => sum + toNumber(entry.total ?? entry.value), 0);
    const expenses = financeEntries.filter(isExpenseEntry).reduce((sum: number, entry: any) => sum + toNumber(entry.total ?? entry.value), 0);
    const invoiced = invoices.reduce((sum: number, invoice: any) => sum + toNumber(invoice.total ?? invoice.value), 0);
    const glosaValue = tissBatches.reduce((sum: number, batch: any) => (
      sum + batch.items.reduce((itemSum: number, item: any) => itemSum + toNumber(item.glosaValue), 0)
    ), 0);
    const pendingTiss = tissBatches.filter((batch: any) => ['DRAFT', 'GENERATED', 'SENT', 'REJECTED'].includes(normalizeStatus(batch.status))).length;
    const criticalStock = inventoryItems.filter((item: any) => {
      const minQuantity = toNumber(item.minQuantity);
      const quantity = toNumber(item.quantity);
      const status = normalizeStatus(item.status);
      return status.includes('LOW') || status.includes('CRIT') || (minQuantity > 0 && quantity <= minQuantity);
    }).length;
    const stockValue = inventoryItems.reduce((sum: number, item: any) => sum + (toNumber(item.quantity) * toNumber(item.unitPrice)), 0);

    const trendKeys = dateRangeKeys(startDate, endDate);
    const trend = trendKeys.map((key) => {
      const dayAppointments = appointments.filter((item: any) => item.date === key);
      const dayInvoices = invoices.filter((item: any) => formatDateKey(item.issuedAt) === key);
      return {
        date: dateLabel(key),
        key,
        atendimentos: dayAppointments.filter((item: any) => !isCanceledStatus(item.status)).length,
        realizados: dayAppointments.filter((item: any) => isDoneAppointmentStatus(item.status)).length,
        receita: dayInvoices.reduce((sum: number, invoice: any) => sum + toNumber(invoice.total ?? invoice.value), 0),
      };
    });

    const rankBy = (items: Array<Record<string, any>>, pickName: (item: any) => string) => {
      const map = new Map<string, number>();
      items.forEach((item) => {
        const name = pickName(item) || 'Nao informado';
        map.set(name, (map.get(name) || 0) + 1);
      });
      return Array.from(map.entries())
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 8);
    };

    const funnel = [
      { name: 'Agendados', value: appointments.length },
      { name: 'Pre-atendimento', value: preSchedulingCount },
      { name: 'Recepcao', value: receptionCount },
      { name: 'Consultas/Exames', value: consultationsCount || realizedAppointments },
      { name: 'Laudos', value: signedReports },
      { name: 'Faturados', value: invoices.length },
    ];

    return {
      filters: {
        startDate: appointmentStartKey,
        endDate: appointmentEndKey,
        branchId: branchId || null,
      },
      kpis: {
        revenue,
        expenses,
        invoiced,
        realizedAppointments,
        appointments: appointments.length,
        pendingAppointments,
        canceledAppointments,
        attendanceRate: appointments.length > 0 ? (realizedAppointments / appointments.length) * 100 : 0,
        ticketAverage: realizedAppointments > 0 ? (invoiced || revenue) / realizedAppointments : 0,
        pendingReports,
        signedReports,
        pendingAuthorizations: authorizationsPending,
        deniedAuthorizations: authorizationsDenied,
        criticalStock,
        stockValue,
        activeTeaProfiles,
        teaPendingReservations,
        pendingTiss,
        glosaValue,
      },
      charts: {
        trend,
        funnel,
        specialties: rankBy(appointments, (item) => item.specialty || item.type || 'Sem especialidade'),
        insuranceMix: rankBy(appointments, (item) => item.convenio || 'Particular/sem convenio'),
      },
      alerts: [
        {
          key: 'authorizations',
          title: 'Autorizacoes pendentes',
          value: authorizationsPending,
          detail: authorizationsDenied > 0 ? `${authorizationsDenied} negadas exigem revisao` : 'Sem negativas relevantes',
          tone: authorizationsPending > 0 ? 'orange' : 'teal',
        },
        {
          key: 'reports',
          title: 'Laudos no backlog',
          value: pendingReports,
          detail: 'Priorize exames com maior SLA',
          tone: pendingReports > 0 ? 'red' : 'teal',
        },
        {
          key: 'stock',
          title: 'Estoque critico',
          value: criticalStock,
          detail: 'Itens abaixo do minimo operacional',
          tone: criticalStock > 0 ? 'yellow' : 'teal',
        },
        {
          key: 'tiss',
          title: 'TISS pendente',
          value: pendingTiss,
          detail: glosaValue > 0 ? `${glosaValue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} em glosas` : 'Sem glosas registradas',
          tone: pendingTiss > 0 ? 'grape' : 'teal',
        },
      ],
      meta: {
        generatedAt: new Date().toISOString(),
        source: 'backend-aggregated-v1',
        notes: [
          'Financeiro, faturamento e estoque ainda nao possuem branchId no schema atual; os totais dessas areas sao agregados no escopo administrativo disponivel.',
        ],
      },
    };
  });

  app.get('/occupancy', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'BI occupancy indicators',
      tags: ['BI'],
      security: [{ bearerAuth: [] }],
      querystring: biCommonQuerystringSchema,
    },
  }, async (request, reply) => {
    const requestUserId = (request.user as any).id as string;
    const context = await getLoggedContext(requestUserId);

    if (!context.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    if (!context.hasBiAccess) {
      return reply.code(403).send({ error: 'User does not have BI access' });
    }

    const query = request.query as any;
    const now = new Date();
    const defaultStart = addDays(now, -29);
    const startDate = parseDateBoundary(query.startDate, defaultStart);
    const endDate = parseDateBoundary(query.endDate, now, true);
    const startDateKey = formatDateKey(startDate);
    const endDateKey = formatDateKey(endDate);
    const branchId = String(query.branchId || context.branchId || '').trim();
    const branchWhere = branchId ? { branchId } : {};

    const [appointments, rooms, equipments, doctors] = await Promise.all([
      prisma.appointment.findMany({
        where: {
          ...branchWhere,
          isActive: true,
          date: {
            gte: startDateKey,
            lte: endDateKey,
          },
        },
        select: {
          id: true,
          date: true,
          time: true,
          durationMinutes: true,
          status: true,
          doctorName: true,
          roomId: true,
          medicalEquipmentId: true,
          specialty: true,
          type: true,
        },
      }),
      prisma.sector.findMany({
        where: {
          ...branchWhere,
          OR: [
            { description: { startsWith: '[sala]', mode: 'insensitive' } },
            { description: { startsWith: '__room__', mode: 'insensitive' } },
            { name: { startsWith: 'Sala', mode: 'insensitive' } },
            { name: { startsWith: 'Room', mode: 'insensitive' } },
          ],
        },
        select: {
          id: true,
          name: true,
          workingDays: true,
          workingHoursStart: true,
          workingHoursEnd: true,
        },
      }),
      prisma.medicalEquipment.findMany({
        where: {
          ...branchWhere,
          isActive: true,
        },
        select: {
          id: true,
          name: true,
          modality: true,
          roomId: true,
        },
      }),
      prisma.doctor.findMany({
        where: {
          ...branchWhere,
          isActive: true,
        },
        select: {
          id: true,
          name: true,
          specialty: true,
          specialties: true,
          workingDays: true,
          workingHoursStart: true,
          workingHoursEnd: true,
        },
      }),
    ]);

    const periodKeys = dateRangeKeys(startDate, endDate);
    const allDateKeys = (() => {
      const keys: string[] = [];
      const totalDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1);
      for (let index = 0; index < totalDays; index += 1) keys.push(formatDateKey(addDays(startDate, index)));
      return keys;
    })();
    const weekdayNames = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];

    const workingMinutesForResource = (resource: any) => {
      const start = timeToMinutes(resource?.workingHoursStart) ?? 8 * 60;
      const end = timeToMinutes(resource?.workingHoursEnd) ?? 18 * 60;
      const minutesPerDay = Math.max(0, end - start);
      const days = Array.isArray(resource?.workingDays) && resource.workingDays.length > 0
        ? allDateKeys.filter((key) => {
          const date = new Date(`${key}T12:00:00.000Z`);
          const weekday = weekdayNames[date.getUTCDay()];
          return resource.workingDays.map((item: string) => normalizeStatus(item).toLowerCase()).includes(weekday);
        }).length
        : allDateKeys.length;
      return Math.max(1, minutesPerDay * Math.max(1, days));
    };

    const activeAppointments = appointments.filter((item: any) => !isCanceledStatus(item.status));
    const bookedMinutes = activeAppointments.reduce((sum: number, item: any) => sum + appointmentDuration(item.durationMinutes), 0);
    const canceledCount = appointments.length - activeAppointments.length;
    const noResourceCount = activeAppointments.filter((item: any) => !item.roomId && !item.medicalEquipmentId).length;

    const buildResourceRanking = (
      resources: any[],
      pickAppointments: (resource: any) => any[],
      fallbackName: (item: any) => string,
    ) => resources.map((resource) => {
      const resourceAppointments = pickAppointments(resource);
      const minutes = resourceAppointments.reduce((sum: number, item: any) => sum + appointmentDuration(item.durationMinutes), 0);
      const capacity = workingMinutesForResource(resource);
      return {
        id: String(resource.id),
        name: fallbackName(resource),
        bookedMinutes: minutes,
        capacityMinutes: capacity,
        occupancyRate: capacity > 0 ? (minutes / capacity) * 100 : 0,
        appointments: resourceAppointments.length,
        idleMinutes: Math.max(0, capacity - minutes),
      };
    }).sort((a, b) => b.occupancyRate - a.occupancyRate);

    const roomRanking = buildResourceRanking(
      rooms,
      (room) => activeAppointments.filter((item: any) => String(item.roomId || '') === String(room.id)),
      (room) => String(room.name || 'Sala sem nome'),
    );

    const equipmentRanking = buildResourceRanking(
      equipments,
      (equipment) => activeAppointments.filter((item: any) => String(item.medicalEquipmentId || '') === String(equipment.id)),
      (equipment) => String(equipment.modality ? `${equipment.name} (${equipment.modality})` : equipment.name || 'Equipamento sem nome'),
    );

    const doctorNameMap = new Map(doctors.map((doctor: any) => [normalizeStatus(doctor.name), doctor]));
    const doctorAppointmentGroups = new Map<string, any[]>();
    activeAppointments.forEach((item: any) => {
      const key = normalizeStatus(item.doctorName || 'Profissional nao informado');
      doctorAppointmentGroups.set(key, [...(doctorAppointmentGroups.get(key) || []), item]);
    });
    const doctorRanking = Array.from(doctorAppointmentGroups.entries()).map(([key, items]) => {
      const doctor: any = doctorNameMap.get(key) || { id: key, name: items[0]?.doctorName || 'Profissional nao informado' };
      const minutes = items.reduce((sum: number, item: any) => sum + appointmentDuration(item.durationMinutes), 0);
      const capacity = workingMinutesForResource(doctor);
      return {
        id: String(doctor.id || key),
        name: String(doctor.name || items[0]?.doctorName || 'Profissional nao informado'),
        bookedMinutes: minutes,
        capacityMinutes: capacity,
        occupancyRate: capacity > 0 ? (minutes / capacity) * 100 : 0,
        appointments: items.length,
        idleMinutes: Math.max(0, capacity - minutes),
      };
    }).sort((a, b) => b.occupancyRate - a.occupancyRate);

    const heatmapMap = new Map<string, { hour: string; appointments: number; minutes: number }>();
    activeAppointments.forEach((item: any) => {
      const start = timeToMinutes(item.time);
      if (start === null) return;
      const label = minutesToHourLabel(start);
      const current = heatmapMap.get(label) || { hour: label, appointments: 0, minutes: 0 };
      current.appointments += 1;
      current.minutes += appointmentDuration(item.durationMinutes);
      heatmapMap.set(label, current);
    });
    const hourlyDemand = Array.from(heatmapMap.values()).sort((a, b) => a.hour.localeCompare(b.hour));
    const peakHours = [...hourlyDemand].sort((a, b) => b.appointments - a.appointments).slice(0, 5);

    const availableCapacity = [...roomRanking, ...equipmentRanking, ...doctorRanking].reduce((sum, item) => sum + item.capacityMinutes, 0);
    const overallOccupancyRate = availableCapacity > 0 ? (bookedMinutes / availableCapacity) * 100 : 0;

    return {
      filters: {
        startDate: startDateKey,
        endDate: endDateKey,
        branchId: branchId || null,
      },
      kpis: {
        appointments: activeAppointments.length,
        canceledAppointments: canceledCount,
        bookedMinutes,
        capacityMinutes: availableCapacity,
        occupancyRate: overallOccupancyRate,
        idleMinutes: Math.max(0, availableCapacity - bookedMinutes),
        noResourceAppointments: noResourceCount,
        roomsCount: rooms.length,
        equipmentsCount: equipments.length,
        professionalsCount: doctorRanking.length,
      },
      rankings: {
        rooms: roomRanking.slice(0, 10),
        equipments: equipmentRanking.slice(0, 10),
        professionals: doctorRanking.slice(0, 10),
      },
      charts: {
        hourlyDemand,
        peakHours,
        period: periodKeys.map((key) => {
          const dayAppointments = activeAppointments.filter((item: any) => item.date === key);
          return {
            date: dateLabel(key),
            key,
            appointments: dayAppointments.length,
            bookedMinutes: dayAppointments.reduce((sum: number, item: any) => sum + appointmentDuration(item.durationMinutes), 0),
          };
        }),
      },
      alerts: [
        {
          key: 'idle',
          title: 'Ociosidade estimada',
          value: Math.round(Math.max(0, availableCapacity - bookedMinutes) / 60),
          detail: 'Horas livres no periodo considerando agenda operacional cadastrada',
          tone: overallOccupancyRate < 55 ? 'orange' : 'teal',
        },
        {
          key: 'resources',
          title: 'Agendamentos sem recurso',
          value: noResourceCount,
          detail: 'Sem sala ou equipamento vinculado',
          tone: noResourceCount > 0 ? 'yellow' : 'teal',
        },
        {
          key: 'cancelations',
          title: 'Cancelamentos',
          value: canceledCount,
          detail: 'Agendamentos cancelados/desmarcados no periodo',
          tone: canceledCount > 0 ? 'red' : 'teal',
        },
      ],
      meta: {
        generatedAt: new Date().toISOString(),
        source: 'backend-aggregated-v1',
        notes: [
          'Capacidade usa horas cadastradas de salas e profissionais; quando ausente, assume 08:00-18:00.',
          'Equipamentos usam a janela operacional padrao ate receberem agenda propria no schema.',
        ],
      },
    };
  });

  app.get('/financial', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'BI financial indicators',
      tags: ['BI'],
      security: [{ bearerAuth: [] }],
      querystring: biCommonQuerystringSchema,
    },
  }, async (request, reply) => {
    const requestUserId = (request.user as any).id as string;
    const context = await getLoggedContext(requestUserId);

    if (!context.companyId) return reply.code(403).send({ error: 'User not associated with a company' });
    if (!context.hasBiAccess) return reply.code(403).send({ error: 'User does not have BI access' });

    const query = request.query as any;
    const now = new Date();
    const startDate = parseDateBoundary(query.startDate, addDays(now, -29));
    const endDate = parseDateBoundary(query.endDate, now, true);
    const startKey = formatDateKey(startDate);
    const endKey = formatDateKey(endDate);
    const branchId = String(query.branchId || context.branchId || '').trim();
    const createdAtWhere = { gte: startDate, lte: endDate };

    const [entries, invoices, tissBatches] = await Promise.all([
      prisma.financeEntry.findMany({
        where: {
          isActive: true,
          OR: [
            { dueDate: createdAtWhere },
            { createdAt: createdAtWhere },
          ],
        },
        select: {
          id: true,
          type: true,
          category: true,
          status: true,
          value: true,
          total: true,
          discount: true,
          dueDate: true,
          createdAt: true,
        },
      }),
      prisma.invoice.findMany({
        where: {
          isActive: true,
          issuedAt: createdAtWhere,
        },
        select: {
          id: true,
          status: true,
          convention: true,
          total: true,
          value: true,
          issuedAt: true,
        },
      }),
      prisma.tissBatch.findMany({
        where: {
          isActive: true,
          createdAt: createdAtWhere,
        },
        include: {
          items: {
            where: { isActive: true },
            select: {
              glosaValue: true,
              returnStatus: true,
              status: true,
            },
          },
        },
      }),
    ]);

    const entriesWithDate = entries.map((item: any) => ({
      ...item,
      baseDate: item.dueDate || item.createdAt,
      amount: toNumber(item.total ?? item.value),
    }));
    const invoicesWithDate = invoices.map((item: any) => ({
      ...item,
      baseDate: item.issuedAt,
      amount: toNumber(item.total ?? item.value),
    }));

    const revenue = entriesWithDate.filter(isRevenueEntry).reduce((sum: number, item: any) => sum + item.amount, 0);
    const expenses = entriesWithDate.filter(isExpenseEntry).reduce((sum: number, item: any) => sum + item.amount, 0);
    const invoiced = invoicesWithDate.reduce((sum: number, item: any) => sum + item.amount, 0);
    const grossMargin = revenue - expenses;
    const marginRate = revenue > 0 ? (grossMargin / revenue) * 100 : 0;

    const openReceivables = entriesWithDate
      .filter((item: any) => isRevenueEntry(item) && ['PENDING', 'OPEN', 'OVERDUE'].includes(normalizeStatus(item.status)))
      .reduce((sum: number, item: any) => sum + item.amount, 0);
    const overdueReceivables = entriesWithDate
      .filter((item: any) => isRevenueEntry(item) && normalizeStatus(item.status).includes('OVERDUE'))
      .reduce((sum: number, item: any) => sum + item.amount, 0);

    const glosaValue = tissBatches.reduce((sum: number, batch: any) => (
      sum + batch.items.reduce((itemSum: number, item: any) => itemSum + toNumber(item.glosaValue), 0)
    ), 0);
    const pendingTiss = tissBatches.filter((batch: any) => ['DRAFT', 'GENERATED', 'SENT', 'REJECTED'].includes(normalizeStatus(batch.status))).length;

    const trendKeys = dateRangeKeys(startDate, endDate);
    const cashflowTrend = trendKeys.map((key) => {
      const dayRevenue = entriesWithDate
        .filter((item: any) => isRevenueEntry(item) && formatDateKey(item.baseDate) === key)
        .reduce((sum: number, item: any) => sum + item.amount, 0);
      const dayExpenses = entriesWithDate
        .filter((item: any) => isExpenseEntry(item) && formatDateKey(item.baseDate) === key)
        .reduce((sum: number, item: any) => sum + item.amount, 0);
      const dayInvoiced = invoicesWithDate
        .filter((item: any) => formatDateKey(item.baseDate) === key)
        .reduce((sum: number, item: any) => sum + item.amount, 0);
      return { key, date: dateLabel(key), revenue: dayRevenue, expenses: dayExpenses, invoiced: dayInvoiced };
    });

    const insuranceMixMap = new Map<string, number>();
    invoicesWithDate.forEach((invoice: any) => {
      const key = invoice.convention || 'Sem convenio';
      insuranceMixMap.set(key, (insuranceMixMap.get(key) || 0) + invoice.amount);
    });

    return {
      filters: {
        startDate: startKey,
        endDate: endKey,
        branchId: branchId || null,
      },
      kpis: {
        revenue,
        expenses,
        invoiced,
        grossMargin,
        marginRate,
        openReceivables,
        overdueReceivables,
        glosaValue,
        pendingTiss,
      },
      charts: {
        cashflowTrend,
        insuranceRevenueMix: Array.from(insuranceMixMap.entries())
          .map(([name, value]) => ({ name, value }))
          .sort((a, b) => b.value - a.value)
          .slice(0, 8),
      },
      alerts: [
        {
          key: 'margin',
          title: 'Margem operacional',
          value: `${marginRate.toFixed(1)}%`,
          detail: grossMargin >= 0 ? 'Fluxo operacional positivo no periodo' : 'Despesas acima das entradas',
          tone: grossMargin >= 0 ? 'teal' : 'red',
        },
        {
          key: 'receivables',
          title: 'Recebiveis em aberto',
          value: openReceivables.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
          detail: overdueReceivables > 0
            ? `${overdueReceivables.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} em atraso`
            : 'Sem atrasos relevantes',
          tone: overdueReceivables > 0 ? 'orange' : 'teal',
        },
      ],
      meta: {
        generatedAt: new Date().toISOString(),
        source: 'backend-aggregated-v1',
        notes: [
          'Entradas/saidas usam financeEntry por dueDate/createdAt no periodo.',
          'Escopo por filial depende do schema financeiro atual; branchId ainda nao e aplicado nesses registros.',
        ],
      },
    };
  });

  app.get('/clinical', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'BI clinical indicators and report SLA',
      tags: ['BI'],
      security: [{ bearerAuth: [] }],
      querystring: biCommonQuerystringSchema,
    },
  }, async (request, reply) => {
    const requestUserId = (request.user as any).id as string;
    const context = await getLoggedContext(requestUserId);

    if (!context.companyId) return reply.code(403).send({ error: 'User not associated with a company' });
    if (!context.hasBiAccess) return reply.code(403).send({ error: 'User does not have BI access' });

    const query = request.query as any;
    const now = new Date();
    const startDate = parseDateBoundary(query.startDate, addDays(now, -29));
    const endDate = parseDateBoundary(query.endDate, now, true);
    const startKey = formatDateKey(startDate);
    const endKey = formatDateKey(endDate);
    const branchId = String(query.branchId || context.branchId || '').trim();
    const branchWhere = branchId ? { branchId } : {};
    const createdAtWhere = { gte: startDate, lte: endDate };

    const [reports, worklistPendingCount, pendingAuthorizations, deniedAuthorizations] = await Promise.all([
      prisma.report.findMany({
        where: {
          ...branchWhere,
          isActive: true,
          createdAt: createdAtWhere,
        },
        select: {
          id: true,
          createdAt: true,
          status: true,
          exam: true,
          issuerSignedAt: true,
          reviewerSignedAt: true,
        },
      }),
      prisma.reportWorklistItem.count({
        where: {
          ...branchWhere,
          isActive: true,
          laudos: {
            none: {
              isActive: true,
            },
          },
        },
      }),
      prisma.appointment.count({
        where: {
          ...branchWhere,
          isActive: true,
          date: { gte: startKey, lte: endKey },
          authorizationStatus: 'PENDING',
        },
      }),
      prisma.appointment.count({
        where: {
          ...branchWhere,
          isActive: true,
          date: { gte: startKey, lte: endKey },
          authorizationStatus: 'DENIED',
        },
      }),
    ]);

    const signedReports = reports.filter((item: any) => item.issuerSignedAt || item.reviewerSignedAt || normalizeStatus(item.status).includes('ASSIN'));
    const pendingReports = reports.filter((item: any) => {
      const status = normalizeStatus(item.status);
      return !status || ['RASCUNHO', 'PENDENTE', 'DRAFT', 'REVIEW', 'REVISAO'].some((token) => status.includes(token));
    });

    const signedWithSla = signedReports.map((item: any) => {
      const signedAt = item.reviewerSignedAt || item.issuerSignedAt;
      const slaHours = signedAt ? Math.max(0, (new Date(signedAt).getTime() - new Date(item.createdAt).getTime()) / 3_600_000) : 0;
      return {
        ...item,
        slaHours,
      };
    }).sort((a: any, b: any) => a.slaHours - b.slaHours);

    const percentile = (arr: number[], p: number) => {
      if (arr.length === 0) return 0;
      const idx = Math.min(arr.length - 1, Math.max(0, Math.floor((p / 100) * arr.length)));
      return arr[idx];
    };
    const slaValues = signedWithSla.map((item: any) => toNumber(item.slaHours)).sort((a: number, b: number) => a - b);
    const avgSla = slaValues.length > 0 ? slaValues.reduce((sum: number, value: number) => sum + value, 0) / slaValues.length : 0;
    const medianSla = percentile(slaValues, 50);
    const p95Sla = percentile(slaValues, 95);

    const backlogAging = [
      { name: 'D0 (hoje)', value: 0 },
      { name: 'D1 (1 dia)', value: 0 },
      { name: 'D2+ (2+ dias)', value: 0 },
    ];
    pendingReports.forEach((item: any) => {
      const days = Math.floor((now.getTime() - new Date(item.createdAt).getTime()) / 86_400_000);
      if (days <= 0) backlogAging[0].value += 1;
      else if (days === 1) backlogAging[1].value += 1;
      else backlogAging[2].value += 1;
    });

    const modalityMap = new Map<string, { name: string; signed: number; avgSlaHours: number }>();
    signedWithSla.forEach((item: any) => {
      const key = String(item.exam || 'Sem modalidade');
      const current = modalityMap.get(key) || { name: key, signed: 0, avgSlaHours: 0 };
      const total = current.avgSlaHours * current.signed;
      current.signed += 1;
      current.avgSlaHours = (total + item.slaHours) / current.signed;
      modalityMap.set(key, current);
    });

    return {
      filters: {
        startDate: startKey,
        endDate: endKey,
        branchId: branchId || null,
      },
      kpis: {
        pendingReports: pendingReports.length + worklistPendingCount,
        signedReports: signedReports.length,
        pendingAuthorizations,
        deniedAuthorizations,
        slaAvgHours: avgSla,
        slaMedianHours: medianSla,
        slaP95Hours: p95Sla,
      },
      charts: {
        backlogAging,
        modalitySla: Array.from(modalityMap.values())
          .sort((a, b) => b.signed - a.signed)
          .slice(0, 8),
      },
      alerts: [
        {
          key: 'sla',
          title: 'SLA p95 de laudos',
          value: `${p95Sla.toFixed(1)}h`,
          detail: p95Sla > 48 ? 'Ponto de atencao para filas antigas' : 'Dentro da janela esperada',
          tone: p95Sla > 48 ? 'orange' : 'teal',
        },
      ],
      meta: {
        generatedAt: new Date().toISOString(),
        source: 'backend-aggregated-v1',
      },
    };
  });

  app.get('/resources', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'BI resources and inventory',
      tags: ['BI'],
      security: [{ bearerAuth: [] }],
      querystring: biCommonQuerystringSchema,
    },
  }, async (request, reply) => {
    const requestUserId = (request.user as any).id as string;
    const context = await getLoggedContext(requestUserId);
    if (!context.companyId) return reply.code(403).send({ error: 'User not associated with a company' });
    if (!context.hasBiAccess) return reply.code(403).send({ error: 'User does not have BI access' });

    const query = request.query as any;
    const now = new Date();
    const startDate = parseDateBoundary(query.startDate, addDays(now, -29));
    const endDate = parseDateBoundary(query.endDate, now, true);

    const [items, movements] = await Promise.all([
      prisma.inventoryItem.findMany({
        where: { isActive: true },
        select: { id: true, name: true, quantity: true, minQuantity: true, unitPrice: true, status: true },
      }),
      prisma.inventoryMovement.findMany({
        where: { createdAt: { gte: startDate, lte: endDate } },
        select: { id: true, inventoryItemId: true, type: true, quantity: true, reason: true, createdAt: true },
      }),
    ]);

    const exits = movements.filter((m: any) => normalizeStatus(m.type).includes('EXIT'));
    const days = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1);
    const consumptionMap = new Map<string, number>();
    exits.forEach((m: any) => consumptionMap.set(m.inventoryItemId, (consumptionMap.get(m.inventoryItemId) || 0) + toNumber(m.quantity)));

    const itemCoverage = items.map((item: any) => {
      const consumed = consumptionMap.get(item.id) || 0;
      const daily = consumed / days;
      const qty = toNumber(item.quantity);
      const coverageDays = daily > 0 ? qty / daily : 999;
      return {
        id: item.id,
        name: item.name || 'Item',
        quantity: qty,
        consumed,
        dailyConsumption: daily,
        coverageDays,
        stockValue: qty * toNumber(item.unitPrice),
      };
    });

    const criticalItems = itemCoverage
      .filter((item: any) => item.coverageDays < 15 || item.quantity <= 0)
      .sort((a: any, b: any) => a.coverageDays - b.coverageDays)
      .slice(0, 8);

    return {
      kpis: {
        itemsCount: items.length,
        criticalCount: criticalItems.length,
        stockValue: itemCoverage.reduce((sum: number, item: any) => sum + item.stockValue, 0),
        periodConsumption: exits.reduce((sum: number, m: any) => sum + toNumber(m.quantity), 0),
      },
      charts: {
        topConsumption: [...itemCoverage].sort((a: any, b: any) => b.consumed - a.consumed).slice(0, 8).map((i: any) => ({ name: i.name, value: i.consumed })),
        coverageRisk: criticalItems.map((i: any) => ({ name: i.name, value: Number(i.coverageDays.toFixed(1)) })),
      },
      lists: { criticalItems },
      meta: { generatedAt: new Date().toISOString(), source: 'backend-aggregated-v1' },
    };
  });

  app.get('/authorizations', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'BI insurance authorizations',
      tags: ['BI'],
      security: [{ bearerAuth: [] }],
      querystring: biCommonQuerystringSchema,
    },
  }, async (request, reply) => {
    const requestUserId = (request.user as any).id as string;
    const context = await getLoggedContext(requestUserId);
    if (!context.companyId) return reply.code(403).send({ error: 'User not associated with a company' });
    if (!context.hasBiAccess) return reply.code(403).send({ error: 'User does not have BI access' });

    const query = request.query as any;
    const now = new Date();
    const startDate = parseDateBoundary(query.startDate, addDays(now, -29));
    const endDate = parseDateBoundary(query.endDate, now, true);
    const startKey = formatDateKey(startDate);
    const endKey = formatDateKey(endDate);
    const branchId = String(query.branchId || context.branchId || '').trim();
    const insuranceId = String(query.insuranceId || '').trim().toLowerCase();
    const branchWhere = branchId ? { branchId } : {};

    const appointmentsRaw = await prisma.appointment.findMany({
      where: {
        ...branchWhere,
        isActive: true,
        date: { gte: startKey, lte: endKey },
      },
      select: {
        id: true,
        convenio: true,
        authorizationStatus: true,
      },
    });
    const appointments = appointmentsRaw.filter((item: any) => (
      !insuranceId || String(item.convenio || '').toLowerCase().includes(insuranceId)
    ));

    const normalizeAuthorization = (value: unknown) => {
      const text = normalizeStatus(value);
      if (text.includes('DENIED') || text.includes('NEG')) return 'DENIED';
      if (text.includes('AUTHORIZED') || text.includes('APROV')) return 'AUTHORIZED';
      if (text.includes('PENDING') || text.includes('PEND')) return 'PENDING';
      return 'OTHER';
    };

    const statusCounts = { PENDING: 0, AUTHORIZED: 0, DENIED: 0, OTHER: 0 };
    const insuranceMap = new Map<string, { name: string; total: number; pending: number; denied: number; authorized: number }>();

    appointments.forEach((item: any) => {
      const status = normalizeAuthorization(item.authorizationStatus);
      statusCounts[status as keyof typeof statusCounts] += 1;
      const insurance = String(item.convenio || 'Sem convenio');
      const current = insuranceMap.get(insurance) || { name: insurance, total: 0, pending: 0, denied: 0, authorized: 0 };
      current.total += 1;
      if (status === 'PENDING') current.pending += 1;
      if (status === 'DENIED') current.denied += 1;
      if (status === 'AUTHORIZED') current.authorized += 1;
      insuranceMap.set(insurance, current);
    });

    const total = appointments.length || 1;
    const pendingRate = (statusCounts.PENDING / total) * 100;
    const deniedRate = (statusCounts.DENIED / total) * 100;
    const approvalRate = (statusCounts.AUTHORIZED / total) * 100;

    return {
      kpis: {
        total: appointments.length,
        pending: statusCounts.PENDING,
        denied: statusCounts.DENIED,
        authorized: statusCounts.AUTHORIZED,
        pendingRate,
        deniedRate,
        approvalRate,
      },
      charts: {
        statusMix: [
          { name: 'Pendentes', value: statusCounts.PENDING },
          { name: 'Autorizadas', value: statusCounts.AUTHORIZED },
          { name: 'Negadas', value: statusCounts.DENIED },
        ],
        insuranceRanking: Array.from(insuranceMap.values())
          .sort((a, b) => b.total - a.total)
          .slice(0, 8),
      },
      meta: { generatedAt: new Date().toISOString(), source: 'backend-aggregated-v1' },
    };
  });

  app.get('/tea', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'BI TEA indicators',
      tags: ['BI'],
      security: [{ bearerAuth: [] }],
      querystring: biCommonQuerystringSchema,
    },
  }, async (request, reply) => {
    const requestUserId = (request.user as any).id as string;
    const context = await getLoggedContext(requestUserId);
    if (!context.companyId) return reply.code(403).send({ error: 'User not associated with a company' });
    if (!context.hasBiAccess) return reply.code(403).send({ error: 'User does not have BI access' });

    const query = request.query as any;
    const now = new Date();
    const startDate = parseDateBoundary(query.startDate, addDays(now, -29));
    const endDate = parseDateBoundary(query.endDate, now, true);
    const branchId = String(query.branchId || context.branchId || '').trim();

    const [activeProfiles, reservations] = await Promise.all([
      prisma.teaProfile.count({
        where: {
          isActive: true,
          patient: branchId ? { branchId } : undefined,
        },
      }),
      prisma.teaPreReservation.findMany({
        where: {
          createdAt: { gte: startDate, lte: endDate },
          patient: branchId ? { branchId } : undefined,
        },
        select: { id: true, status: true, createdAt: true },
      }),
    ]);

    const isStatus = (raw: unknown, tokens: string[]) => {
      const s = normalizeStatus(raw);
      return tokens.some((t) => s.includes(t));
    };

    const pending = reservations.filter((r: any) => isStatus(r.status, ['PENDING', 'PROPOSED', 'RESERVED'])).length;
    const converted = reservations.filter((r: any) => isStatus(r.status, ['CONVERTED', 'AUTHORIZED'])).length;
    const canceled = reservations.filter((r: any) => isStatus(r.status, ['CANCEL'])).length;
    const conversionRate = reservations.length > 0 ? (converted / reservations.length) * 100 : 0;

    const periodKeys = dateRangeKeys(startDate, endDate);
    const trend = periodKeys.map((key) => {
      const dayItems = reservations.filter((r: any) => formatDateKey(r.createdAt) === key);
      return {
        date: dateLabel(key),
        pendentes: dayItems.filter((r: any) => isStatus(r.status, ['PENDING', 'PROPOSED', 'RESERVED'])).length,
        convertidas: dayItems.filter((r: any) => isStatus(r.status, ['CONVERTED', 'AUTHORIZED'])).length,
        canceladas: dayItems.filter((r: any) => isStatus(r.status, ['CANCEL'])).length,
      };
    });

    return {
      kpis: { activeProfiles, pendingReservations: pending, convertedReservations: converted, canceledReservations: canceled, conversionRate },
      charts: {
        reservationMix: [
          { name: 'Pendentes', value: pending },
          { name: 'Convertidas', value: converted },
          { name: 'Canceladas', value: canceled },
        ],
        trend,
      },
      meta: { generatedAt: new Date().toISOString(), source: 'backend-aggregated-v1' },
    };
  });

  app.get('/reports', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'BI reports and exams indicators',
      tags: ['BI'],
      security: [{ bearerAuth: [] }],
      querystring: biCommonQuerystringSchema,
    },
  }, async (request, reply) => {
    const requestUserId = (request.user as any).id as string;
    const context = await getLoggedContext(requestUserId);
    if (!context.companyId) return reply.code(403).send({ error: 'User not associated with a company' });
    if (!context.hasBiAccess) return reply.code(403).send({ error: 'User does not have BI access' });

    const query = request.query as any;
    const now = new Date();
    const startDate = parseDateBoundary(query.startDate, addDays(now, -29));
    const endDate = parseDateBoundary(query.endDate, now, true);
    const startKey = formatDateKey(startDate);
    const endKey = formatDateKey(endDate);
    const branchId = String(query.branchId || context.branchId || '').trim();
    const doctorId = String(query.doctorId || '').trim().toLowerCase();
    const procedureId = String(query.procedureId || '').trim().toLowerCase();
    const branchWhere = branchId ? { branchId } : {};

    const [reports, worklistPendingCount, appointments] = await Promise.all([
      prisma.report.findMany({
        where: {
          ...branchWhere,
          isActive: true,
          createdAt: { gte: startDate, lte: endDate },
        },
        select: {
          id: true,
          status: true,
          exam: true,
          createdAt: true,
          issuerSignedAt: true,
          reviewerSignedAt: true,
        },
      }),
      prisma.reportWorklistItem.count({
        where: {
          ...branchWhere,
          isActive: true,
          laudos: {
            none: {
              isActive: true,
            },
          },
        },
      }),
      prisma.appointment.findMany({
        where: {
          ...branchWhere,
          isActive: true,
          date: { gte: startKey, lte: endKey },
        },
        select: { id: true, type: true, specialty: true, doctorName: true, medicalEquipmentId: true },
      }),
    ]);
    const filteredAppointments = appointments.filter((item: any) => {
      if (doctorId && !String(item.doctorName || '').toLowerCase().includes(doctorId)) return false;
      if (procedureId && !`${String(item.type || '')} ${String(item.specialty || '')}`.toLowerCase().includes(procedureId)) return false;
      return true;
    });

    const pending = reports.filter((item: any) => {
      const s = normalizeStatus(item.status);
      return !s || ['PENDENTE', 'DRAFT', 'REVIEW', 'RASCUNHO', 'REVISAO'].some((token) => s.includes(token));
    });
    const signed = reports.filter((item: any) => item.issuerSignedAt || item.reviewerSignedAt || normalizeStatus(item.status).includes('ASSIN'));
    const reviewPending = reports.filter((item: any) => {
      const s = normalizeStatus(item.status);
      return s.includes('REVIEW') || s.includes('REVISAO');
    });

    const tatHours = signed.map((item: any) => {
      const signedAt = item.reviewerSignedAt || item.issuerSignedAt;
      if (!signedAt) return 0;
      return Math.max(0, (new Date(signedAt).getTime() - new Date(item.createdAt).getTime()) / 3_600_000);
    }).sort((a: number, b: number) => a - b);
    const tatAvg = tatHours.length > 0 ? tatHours.reduce((sum: number, value: number) => sum + value, 0) / tatHours.length : 0;
    const tatP95 = tatHours.length > 0 ? tatHours[Math.min(tatHours.length - 1, Math.floor(tatHours.length * 0.95))] : 0;

    const modalityMap = new Map<string, number>();
    reports.forEach((item: any) => {
      const key = String(item.exam || 'Sem modalidade');
      modalityMap.set(key, (modalityMap.get(key) || 0) + 1);
    });
    const examVolume = Array.from(modalityMap.entries()).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 10);

    const equipmentExams = filteredAppointments.filter((item: any) => Boolean(item.medicalEquipmentId)).length;
    const alerts = [
      {
        key: 'backlog',
        title: 'Backlog de laudos',
        value: pending.length + worklistPendingCount,
        detail: 'Itens pendentes na fila de laudo',
        tone: pending.length + worklistPendingCount > 0 ? 'orange' : 'teal',
      },
      {
        key: 'tat',
        title: 'TAT p95',
        value: `${tatP95.toFixed(1)}h`,
        detail: tatP95 > 48 ? 'Acima do esperado' : 'Dentro da meta operacional',
        tone: tatP95 > 48 ? 'red' : 'teal',
      },
    ];

    return {
      kpis: {
        pendingReports: pending.length + worklistPendingCount,
        signedReports: signed.length,
        reviewPending: reviewPending.length,
        tatAvgHours: tatAvg,
        tatP95Hours: tatP95,
        examAppointments: filteredAppointments.length,
        equipmentExams,
      },
      charts: { examVolume },
      alerts,
      meta: { generatedAt: new Date().toISOString(), source: 'backend-aggregated-v1' },
    };
  });

  app.get('/communication', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'BI communication and patient experience',
      tags: ['BI'],
      security: [{ bearerAuth: [] }],
      querystring: biCommonQuerystringSchema,
    },
  }, async (request, reply) => {
    const requestUserId = (request.user as any).id as string;
    const context = await getLoggedContext(requestUserId);
    if (!context.companyId) return reply.code(403).send({ error: 'User not associated with a company' });
    if (!context.hasBiAccess) return reply.code(403).send({ error: 'User does not have BI access' });

    const query = request.query as any;
    const now = new Date();
    const startDate = parseDateBoundary(query.startDate, addDays(now, -29));
    const endDate = parseDateBoundary(query.endDate, now, true);
    const branchId = String(query.branchId || context.branchId || '').trim();

    const [conversations, messages, deliveries] = await Promise.all([
      prisma.whatsAppConversation.findMany({
        where: {
          branchId: branchId || undefined,
          updatedAt: { gte: startDate, lte: endDate },
        },
        select: { id: true, humanStatus: true, updatedAt: true, humanFlowKey: true },
      }),
      prisma.whatsAppMessageLog.findMany({
        where: {
          branchId: branchId || undefined,
          createdAt: { gte: startDate, lte: endDate },
        },
        select: { id: true, status: true, createdAt: true },
      }),
      prisma.delivery.findMany({
        where: {
          createdAt: { gte: startDate, lte: endDate },
        },
        select: { id: true, status: true, documentType: true, createdAt: true },
      }),
    ]);

    const openConversations = conversations.filter((item: any) => ['OPEN', 'QUEUED', 'ASSIGNED'].includes(normalizeStatus(item.humanStatus))).length;
    const closedConversations = conversations.filter((item: any) => normalizeStatus(item.humanStatus).includes('CLOSED')).length;
    const outboundMessages = messages.length;
    const failedMessages = messages.filter((item: any) => normalizeStatus(item.status).includes('FAIL') || normalizeStatus(item.status).includes('ERROR')).length;
    const deliveredDocs = deliveries.filter((item: any) => normalizeStatus(item.status).includes('ENTREG') || normalizeStatus(item.status).includes('DELIVER')).length;
    const pendingDocs = deliveries.length - deliveredDocs;

    const flowMap = new Map<string, number>();
    conversations.forEach((item: any) => {
      const key = String(item.humanFlowKey || 'Sem fluxo');
      flowMap.set(key, (flowMap.get(key) || 0) + 1);
    });

    return {
      kpis: {
        conversationsOpen: openConversations,
        conversationsClosed: closedConversations,
        messagesSent: outboundMessages,
        messageFailureRate: outboundMessages > 0 ? (failedMessages / outboundMessages) * 100 : 0,
        deliveriesPending: pendingDocs,
        deliveriesCompleted: deliveredDocs,
      },
      charts: {
        conversationFlows: Array.from(flowMap.entries()).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 8),
        deliveryStatus: [
          { name: 'Pendentes', value: pendingDocs },
          { name: 'Concluídas', value: deliveredDocs },
        ],
      },
      meta: { generatedAt: new Date().toISOString(), source: 'backend-aggregated-v1' },
    };
  });

  app.get('/appointments', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'BI appointments and operation',
      tags: ['BI'],
      security: [{ bearerAuth: [] }],
      querystring: biCommonQuerystringSchema,
    },
  }, async (request, reply) => {
    const requestUserId = (request.user as any).id as string;
    const context = await getLoggedContext(requestUserId);
    if (!context.companyId) return reply.code(403).send({ error: 'User not associated with a company' });
    if (!context.hasBiAccess) return reply.code(403).send({ error: 'User does not have BI access' });

    const query = request.query as any;
    const now = new Date();
    const startDate = parseDateBoundary(query.startDate, addDays(now, -29));
    const endDate = parseDateBoundary(query.endDate, now, true);
    const startKey = formatDateKey(startDate);
    const endKey = formatDateKey(endDate);
    const branchId = String(query.branchId || context.branchId || '').trim();
    const doctorId = String(query.doctorId || '').trim().toLowerCase();
    const procedureId = String(query.procedureId || '').trim().toLowerCase();
    const branchWhere = branchId ? { branchId } : {};

    const appointmentsRaw = await prisma.appointment.findMany({
      where: { ...branchWhere, isActive: true, date: { gte: startKey, lte: endKey } },
      select: { id: true, date: true, time: true, status: true, specialty: true, doctorName: true, medicalEquipmentId: true, roomId: true },
    });
    const appointments = appointmentsRaw.filter((item: any) => {
      if (doctorId && !String(item.doctorName || '').toLowerCase().includes(doctorId)) return false;
      if (procedureId && !String(item.specialty || '').toLowerCase().includes(procedureId)) return false;
      return true;
    });

    const scheduled = appointments.length;
    const realized = appointments.filter((item: any) => isDoneAppointmentStatus(item.status)).length;
    const canceled = appointments.filter((item: any) => isCanceledStatus(item.status)).length;
    const pending = appointments.filter((item: any) => isPendingAppointmentStatus(item.status)).length;

    const trendKeys = dateRangeKeys(startDate, endDate);
    const trend = trendKeys.map((key) => {
      const dayItems = appointments.filter((item: any) => item.date === key);
      return {
        date: dateLabel(key),
        agendados: dayItems.length,
        realizados: dayItems.filter((item: any) => isDoneAppointmentStatus(item.status)).length,
        cancelados: dayItems.filter((item: any) => isCanceledStatus(item.status)).length,
      };
    });

    return {
      kpis: {
        scheduled,
        realized,
        canceled,
        pending,
        attendanceRate: scheduled > 0 ? (realized / scheduled) * 100 : 0,
      },
      charts: { trend },
      meta: { generatedAt: new Date().toISOString(), source: 'backend-aggregated-v1' },
    };
  });

  app.get('/inventory', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'BI inventory dedicated',
      tags: ['BI'],
      security: [{ bearerAuth: [] }],
      querystring: biCommonQuerystringSchema,
    },
  }, async (request, reply) => {
    const requestUserId = (request.user as any).id as string;
    const context = await getLoggedContext(requestUserId);
    if (!context.companyId) return reply.code(403).send({ error: 'User not associated with a company' });
    if (!context.hasBiAccess) return reply.code(403).send({ error: 'User does not have BI access' });

    const query = request.query as any;
    const now = new Date();
    const startDate = parseDateBoundary(query.startDate, addDays(now, -29));
    const endDate = parseDateBoundary(query.endDate, now, true);

    const [items, movements] = await Promise.all([
      prisma.inventoryItem.findMany({
        where: { isActive: true },
        select: { id: true, name: true, quantity: true, minQuantity: true, maxQuantity: true, status: true, unitPrice: true, expiryDate: true },
      }),
      prisma.inventoryMovement.findMany({
        where: { createdAt: { gte: startDate, lte: endDate } },
        select: { id: true, inventoryItemId: true, type: true, quantity: true, createdAt: true },
      }),
    ]);

    const critical = items.filter((i: any) => toNumber(i.minQuantity) > 0 && toNumber(i.quantity) <= toNumber(i.minQuantity));
    const expiringSoon = items.filter((i: any) => i.expiryDate && (new Date(i.expiryDate).getTime() - Date.now()) <= 30 * 86_400_000);
    const exits = movements.filter((m: any) => normalizeStatus(m.type).includes('EXIT'));
    const stockValue = items.reduce((sum: number, i: any) => sum + toNumber(i.quantity) * toNumber(i.unitPrice), 0);

    return {
      kpis: {
        totalItems: items.length,
        criticalItems: critical.length,
        expiringSoon: expiringSoon.length,
        periodConsumption: exits.reduce((sum: number, m: any) => sum + toNumber(m.quantity), 0),
        stockValue,
      },
      charts: {
        topConsumption: Array.from(new Map<string, number>(exits.map((m: any) => [m.inventoryItemId, 0])).entries()).map(([id]) => {
          const qty = exits.filter((m: any) => m.inventoryItemId === id).reduce((sum: number, m: any) => sum + toNumber(m.quantity), 0);
          const item = items.find((i: any) => i.id === id);
          return { name: item?.name || 'Item', value: qty };
        }).sort((a, b) => b.value - a.value).slice(0, 8),
      },
      meta: { generatedAt: new Date().toISOString(), source: 'backend-aggregated-v1' },
    };
  });

  app.post('/insights', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Generate AI-powered executive insights from BI data',
      tags: ['BI'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['data'],
        properties: {
          data: { type: 'object', description: 'Aggregated BI data from all panels' },
          period: { type: 'object', properties: { startDate: { type: 'string' }, endDate: { type: 'string' } } },
          filters: { type: 'object' },
          force: { type: 'boolean' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            positives: { type: 'array', items: { type: 'string' } },
            negatives: { type: 'array', items: { type: 'string' } },
            alerts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  priority: { type: 'string' },
                },
              },
            },
            suggestions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  timeframe: { type: 'string' },
                  owner: { type: 'string' },
                },
              },
            },
            summary: { type: 'string' },
            generatedAt: { type: 'string' },
            expiresAt: { type: 'string' },
            fromCache: { type: 'boolean' },
          },
        },
        403: { type: 'object' },
        502: { type: 'object' },
        503: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const requestUserId = (request.user as any).id as string;
    const context = await getLoggedContext(requestUserId);
    if (!context.companyId) return reply.code(403).send({ error: 'User not associated with a company' });
    if (!context.hasBiAccess) return reply.code(403).send({ error: 'User does not have BI access' });

    if (!GROQ_API_KEY) {
      return reply.code(503).send({ error: 'Serviço de IA não configurado. Adicione GROQ_API_KEY ao .env.' });
    }

    const { data, period, filters, force } = request.body as any;
    const companyId = context.companyId;

    const startDate = period?.startDate || '';
    const endDate = period?.endDate || '';
    const filterStr = JSON.stringify(filters || {});
    const cacheKey = `${startDate}|${endDate}|${filterStr}`;
    const CACHE_TTL_HOURS = 2;

    if (!force) {
      const cached = await prisma.biInsightCache.findUnique({
        where: { companyId_cacheKey: { companyId, cacheKey } },
      });
      if (cached && cached.expiresAt > new Date()) {
        return {
          summary: cached.summary,
          positives: cached.positives as string[],
          negatives: cached.negatives as string[],
          alerts: cached.alerts as any[],
          suggestions: cached.suggestions as any[],
          generatedAt: cached.generatedAt.toISOString(),
          expiresAt: cached.expiresAt.toISOString(),
          fromCache: true,
        };
      }
    }

    const periodLabel = startDate && endDate ? `de ${startDate} até ${endDate}` : 'período selecionado';

    const prompt = `Você é um consultor sênior especializado em gestão de clínicas médicas no Brasil. Analise os dados de BI abaixo e gere insights executivos ricos, precisos e acionáveis para o gestor da clínica.

Período analisado: ${periodLabel}

Dados do painel (KPIs e gráficos agregados por módulo):
${JSON.stringify(data, null, 2)}

Retorne APENAS um JSON válido com exatamente esta estrutura (sem markdown, sem texto extra fora do JSON):
{
  "summary": "Resumo executivo em 3-4 frases sobre o estado geral da clínica, citando os 2-3 números mais relevantes do período",
  "positives": [
    "Frase completa citando o número exato que comprova o ponto positivo — ex: 'Taxa de comparecimento de 87%, acima da média setorial de 75%, indicando boa confirmação de agendamentos'"
  ],
  "negatives": [
    "Frase completa citando o número exato que evidencia o problema — ex: 'Backlog de laudos com 23 exames pendentes, representando risco de SLA e insatisfação do paciente'"
  ],
  "alerts": [
    { "text": "Descrição clara do alerta com o número que o justifica", "priority": "CRÍTICO" },
    { "text": "Descrição do alerta", "priority": "ALTO" },
    { "text": "Descrição do alerta", "priority": "MÉDIO" }
  ],
  "suggestions": [
    { "text": "Ação concreta e específica que o responsável deve tomar, com contexto do dado que motivou", "timeframe": "imediato", "owner": "gestão" },
    { "text": "Ação concreta", "timeframe": "esta semana", "owner": "recepção" },
    { "text": "Ação concreta", "timeframe": "este mês", "owner": "financeiro" }
  ]
}

Valores válidos:
- alerts[].priority: "CRÍTICO" | "ALTO" | "MÉDIO"
- suggestions[].timeframe: "imediato" | "esta semana" | "este mês"
- suggestions[].owner: "gestão" | "recepção" | "médico" | "financeiro" | "estoque" | "TI" | "enfermagem"

Regras obrigatórias:
- Todo item de positivos e negativos DEVE citar pelo menos um número ou percentual dos dados fornecidos
- Alerts classificados por severidade real — CRÍTICO apenas para riscos financeiros, operacionais ou de segurança do paciente iminentes
- Sugestões devem ser específicas e acionáveis, não genéricas — diga exatamente o que fazer, não apenas "melhorar X"
- Se um módulo tiver dados zerados, sinalize como "dado indisponível" e não como problema operacional
- Mínimo 2 e máximo 5 itens em cada categoria
- Nunca invente números que não estejam nos dados fornecidos`;

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          temperature: 0.3,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        const err = await response.json() as any;
        return reply.code(502).send({ error: err?.error?.message || 'Erro na API de IA.' });
      }

      const groqData = await response.json() as any;
      const content = groqData.choices?.[0]?.message?.content?.trim();

      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch {
        return reply.code(502).send({ error: 'Resposta inválida da IA. Tente novamente.' });
      }

      const extractText = (item: any) =>
        String(item?.text || item?.description || item?.alert || item?.suggestion || item?.content || item?.action || '').trim();

      const normalizeAlert = (item: any) =>
        typeof item === 'string'
          ? { text: item, priority: 'MÉDIO' as const }
          : { text: extractText(item), priority: ['CRÍTICO', 'ALTO', 'MÉDIO'].includes(item?.priority) ? item.priority : 'MÉDIO' };

      const normalizeSuggestion = (item: any) =>
        typeof item === 'string'
          ? { text: item, timeframe: 'esta semana' as const, owner: 'gestão' }
          : {
              text: extractText(item),
              timeframe: ['imediato', 'esta semana', 'este mês'].includes(item?.timeframe) ? item.timeframe : 'esta semana',
              owner: item?.owner || item?.responsible || item?.responsavel || 'gestão',
            };

      const result = {
        summary: parsed.summary || '',
        positives: Array.isArray(parsed.positives) ? parsed.positives.map(String) : [],
        negatives: Array.isArray(parsed.negatives) ? parsed.negatives.map(String) : [],
        alerts: Array.isArray(parsed.alerts) ? parsed.alerts.map(normalizeAlert) : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.map(normalizeSuggestion) : [],
      };

      const now = new Date();
      const expiresAt = new Date(now.getTime() + CACHE_TTL_HOURS * 60 * 60 * 1000);

      await prisma.biInsightCache.upsert({
        where: { companyId_cacheKey: { companyId, cacheKey } },
        update: { ...result, startDate, endDate, generatedAt: now, expiresAt },
        create: { companyId, cacheKey, startDate, endDate, ...result, expiresAt },
      });

      return { ...result, generatedAt: now.toISOString(), expiresAt: expiresAt.toISOString(), fromCache: false };
    } catch (err: any) {
      return reply.code(502).send({ error: err?.message || 'Não foi possível conectar ao serviço de IA.' });
    }
  });
}
