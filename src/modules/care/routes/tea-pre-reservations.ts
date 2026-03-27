import { FastifyInstance } from 'fastify';
import prismaModule from '../lib/prisma';

const prisma: any = (prismaModule as any)?.default ?? prismaModule;

const OPEN_STATUSES = [
  'PENDING_SCHEDULING',
  'PROPOSED',
  'RESERVED',
  'PENDING_AUTHORIZATION',
  'AUTHORIZED',
] as const;

function buildTimeSlots(startTime: string, endTime: string, stepMinutes: number): string[] {
  const [startHour, startMinute] = String(startTime).split(':').map((part) => Number(part));
  const [endHour, endMinute] = String(endTime).split(':').map((part) => Number(part));
  const startTotal = (Number.isFinite(startHour) ? startHour : 0) * 60 + (Number.isFinite(startMinute) ? startMinute : 0);
  const endTotal = (Number.isFinite(endHour) ? endHour : 0) * 60 + (Number.isFinite(endMinute) ? endMinute : 0);
  const step = Math.max(1, Number(stepMinutes) || 15);

  const slots: string[] = [];
  for (let current = startTotal; current <= endTotal; current += step) {
    const hour = Math.floor(current / 60);
    const minute = current % 60;
    slots.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
  }
  return slots;
}

const SHIFT_TIME_SLOTS: Record<string, string[]> = {
  MANHA: buildTimeSlots('08:00', '11:45', 15),
  TARDE: buildTimeSlots('13:00', '17:45', 15),
  NOITE: buildTimeSlots('18:00', '21:00', 15),
};

const JS_DAY_TO_PIT_WEEKDAY = ['DOMINGO', 'SEGUNDA', 'TERCA', 'QUARTA', 'QUINTA', 'SEXTA', 'SABADO'];
const PIT_WEEKDAY_TO_JS_DAY: Record<string, number> = {
  DOMINGO: 0,
  SEGUNDA: 1,
  TERCA: 2,
  QUARTA: 3,
  QUINTA: 4,
  SEXTA: 5,
  SABADO: 6,
};

function normalizeWeekdayToken(value?: string): string | null {
  if (!value) return null;
  const normalized = String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/-FEIRA/g, '')
    .trim();

  if (normalized === 'SEGUNDA' || normalized === 'MONDAY') return 'SEGUNDA';
  if (normalized === 'TERCA' || normalized === 'TUESDAY') return 'TERCA';
  if (normalized === 'QUARTA' || normalized === 'WEDNESDAY') return 'QUARTA';
  if (normalized === 'QUINTA' || normalized === 'THURSDAY') return 'QUINTA';
  if (normalized === 'SEXTA' || normalized === 'FRIDAY') return 'SEXTA';
  if (normalized === 'SABADO' || normalized === 'SATURDAY') return 'SABADO';
  if (normalized === 'DOMINGO' || normalized === 'SUNDAY') return 'DOMINGO';
  return null;
}

function formatDateAsIso(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeComparableText(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function buildTherapyComparableSignature(input: {
  teaProfileId?: string | null;
  patientId?: string | null;
  procedureId?: string | null;
  procedureName?: string | null;
  professionalId?: string | null;
  professionalName?: string | null;
}): string {
  return [
    normalizeComparableText(input?.teaProfileId || input?.patientId),
    normalizeComparableText(input?.procedureId || input?.procedureName),
    normalizeComparableText(input?.professionalId || input?.professionalName),
  ].join('#');
}

function startOfWeekMonday(date: Date): Date {
  const normalized = new Date(date);
  normalized.setHours(0, 0, 0, 0);
  const day = normalized.getDay();
  const diff = (day + 6) % 7;
  normalized.setDate(normalized.getDate() - diff);
  return normalized;
}

function timeToMinutes(time: string): number {
  const [hours, minutes] = String(time).split(':').map((chunk) => Number(chunk));
  const safeHours = Number.isFinite(hours) ? hours : 0;
  const safeMinutes = Number.isFinite(minutes) ? minutes : 0;
  return safeHours * 60 + safeMinutes;
}

function resolveDurationMinutes(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 15;
  return Math.max(1, Math.min(1440, Math.floor(parsed)));
}

function minutesToTime(totalMinutes: number): string {
  const normalized = Math.max(0, totalMinutes);
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function buildCoveredTimeSlots(startTime: string, durationMinutes?: number | null, stepMinutes = 15): string[] {
  const safeStep = Math.max(1, Number(stepMinutes) || 15);
  const startMinute = timeToMinutes(startTime);
  const safeDuration = resolveDurationMinutes(durationMinutes);
  const slots: string[] = [];

  for (let offset = 0; offset < safeDuration; offset += safeStep) {
    slots.push(minutesToTime(startMinute + offset));
  }

  return Array.from(new Set(slots));
}

function canPlaceSessionAtSlot(
  date: string,
  startTime: string,
  durationMinutes: number | null | undefined,
  occupied: Set<string>,
): boolean {
  const coveredSlots = buildCoveredTimeSlots(startTime, durationMinutes);
  return coveredSlots.every((coveredTime) => !occupied.has(`${date}#${coveredTime}`));
}

function timeRangesOverlap(
  startA: string,
  durationA: number | null | undefined,
  startB: string,
  durationB: number | null | undefined,
): boolean {
  const startAMinutes = timeToMinutes(startA);
  const endAMinutes = startAMinutes + resolveDurationMinutes(durationA);
  const startBMinutes = timeToMinutes(startB);
  const endBMinutes = startBMinutes + resolveDurationMinutes(durationB);
  return startAMinutes < endBMinutes && startBMinutes < endAMinutes;
}

function fitsDoctorWorkingWindow(
  slotTime: string,
  durationMinutes: number,
  workingHoursStart?: string | null,
  workingHoursEnd?: string | null,
): boolean {
  const startMinute = timeToMinutes(slotTime);
  const endMinute = startMinute + resolveDurationMinutes(durationMinutes);

  const windowStartMinute = workingHoursStart ? timeToMinutes(workingHoursStart) : null;
  const windowEndMinute = workingHoursEnd ? timeToMinutes(workingHoursEnd) : null;

  if (windowStartMinute !== null && startMinute < windowStartMinute) return false;
  if (windowEndMinute !== null && endMinute > windowEndMinute) return false;
  return true;
}

type NormalizedDoctorWindow = {
  weekdays: string[];
  hoursStart?: string | null;
  hoursEnd?: string | null;
};

function parseDoctorWorkingWindows(doctor: any): NormalizedDoctorWindow[] {
  const normalizedLegacyDays = Array.isArray(doctor?.workingDays)
    ? doctor.workingDays
      .map((item: any) => normalizeWeekdayToken(item))
      .filter(Boolean) as string[]
    : [];

  const rawSchedules = (() => {
    if (Array.isArray(doctor?.workingSchedules)) return doctor.workingSchedules;
    if (typeof doctor?.workingSchedules === 'string' && doctor.workingSchedules.trim()) {
      try {
        const parsed = JSON.parse(doctor.workingSchedules);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  })();

  const scheduleWindows = rawSchedules
    .map((schedule: any) => {
      const weekdays = Array.isArray(schedule?.days)
        ? schedule.days
          .map((item: any) => normalizeWeekdayToken(item))
          .filter(Boolean) as string[]
        : [];
      if (!weekdays.length) return null;
      return {
        weekdays,
        hoursStart: schedule?.hoursStart || null,
        hoursEnd: schedule?.hoursEnd || null,
      } as NormalizedDoctorWindow;
    })
    .filter((item: NormalizedDoctorWindow | null): item is NormalizedDoctorWindow => Boolean(item));

  if (scheduleWindows.length > 0) {
    return scheduleWindows;
  }

  if (normalizedLegacyDays.length === 0) {
    return [{ weekdays: [...JS_DAY_TO_PIT_WEEKDAY], hoursStart: doctor?.workingHoursStart || null, hoursEnd: doctor?.workingHoursEnd || null }];
  }

  return [{ weekdays: normalizedLegacyDays, hoursStart: doctor?.workingHoursStart || null, hoursEnd: doctor?.workingHoursEnd || null }];
}

function getDoctorWindowsForWeekday(doctor: any, weekdayToken: string): Array<{ hoursStart?: string | null; hoursEnd?: string | null }> {
  const allWindows = parseDoctorWorkingWindows(doctor);
  return allWindows
    .filter((window) => window.weekdays.includes(weekdayToken))
    .map((window) => ({
      hoursStart: window.hoursStart || null,
      hoursEnd: window.hoursEnd || null,
    }));
}

function getShiftSlots(shift?: string | null): string[] {
  if (!shift) {
    return [...SHIFT_TIME_SLOTS.MANHA, ...SHIFT_TIME_SLOTS.TARDE, ...SHIFT_TIME_SLOTS.NOITE];
  }

  const shiftTokens = String(shift)
    .split(',')
    .map((token) => String(token).toUpperCase().trim())
    .filter((token) => token === 'MANHA' || token === 'TARDE' || token === 'NOITE');

  if (!shiftTokens.length) {
    return [...SHIFT_TIME_SLOTS.MANHA, ...SHIFT_TIME_SLOTS.TARDE, ...SHIFT_TIME_SLOTS.NOITE];
  }

  const combined: string[] = [];
  shiftTokens.forEach((token) => {
    if (token === 'MANHA') combined.push(...SHIFT_TIME_SLOTS.MANHA);
    if (token === 'TARDE') combined.push(...SHIFT_TIME_SLOTS.TARDE);
    if (token === 'NOITE') combined.push(...SHIFT_TIME_SLOTS.NOITE);
  });

  return Array.from(new Set(combined)).sort((a, b) => timeToMinutes(a) - timeToMinutes(b));
}

const DOCTOR_AVAILABILITY_SELECT = {
  id: true,
  name: true,
  isActive: true,
  workingDays: true,
  workingHoursStart: true,
  workingHoursEnd: true,
  workingSchedules: true,
} as const;

async function listCandidateDoctorsForTherapy(therapy: any, branchId: string): Promise<any[]> {
  const assignedDoctorId = String(therapy?.professionalDoctorId || '').trim();
  const procedureId = String(therapy?.procedureId || '').trim();

  if (assignedDoctorId) {
    const doctor = await prisma.doctor.findFirst({
      where: { id: assignedDoctorId, branchId, isActive: true },
      select: DOCTOR_AVAILABILITY_SELECT,
    });

    if (!doctor) return [];

    if (procedureId) {
      const linkedProcedureDoctor = await prisma.procedureDoctor.findFirst({
        where: {
          procedureId,
          doctorId: doctor.id,
        },
      });

      if (!linkedProcedureDoctor) {
        return [];
      }
    }

    return [doctor];
  }

  if (!procedureId) return [];

  const links = await prisma.procedureDoctor.findMany({
    where: { procedureId },
    select: { doctorId: true },
  });

  const doctorIds = Array.from(new Set(
    links
      .map((item: any) => String(item?.doctorId || '').trim())
      .filter(Boolean),
  ));

  if (doctorIds.length === 0) return [];

  return prisma.doctor.findMany({
    where: {
      id: { in: doctorIds },
      branchId,
      isActive: true,
    },
    select: DOCTOR_AVAILABILITY_SELECT,
    orderBy: { name: 'asc' },
  });
}

async function resolveAvailableDoctorForSession(input: {
  therapy: any;
  branchId: string;
  candidateDateIso: string;
  suggestedTime: string;
  durationMinutes: number;
  preferredDoctorId?: string | null;
}) {
  const {
    therapy,
    branchId,
    candidateDateIso,
    suggestedTime,
    durationMinutes,
    preferredDoctorId,
  } = input;

  const preferredId = String(preferredDoctorId || '').trim();
  let candidateDoctors = preferredId
    ? await prisma.doctor.findMany({
      where: {
        id: preferredId,
        branchId,
        isActive: true,
      },
      select: DOCTOR_AVAILABILITY_SELECT,
      orderBy: { name: 'asc' },
    })
    : await listCandidateDoctorsForTherapy(therapy, branchId);

  if (!candidateDoctors.length && preferredId && String(therapy?.professionalDoctorId || '').trim() === preferredId) {
    candidateDoctors = await listCandidateDoctorsForTherapy(therapy, branchId);
  }

  if (!candidateDoctors.length) return null;

  const weekdayToken = JS_DAY_TO_PIT_WEEKDAY[new Date(`${candidateDateIso}T00:00:00`).getDay()];
  const dayStart = new Date(`${candidateDateIso}T00:00:00`);
  const dayEnd = new Date(`${candidateDateIso}T23:59:59`);

  const [patientAppointments, patientReservations] = await Promise.all([
    prisma.appointment.findMany({
      where: {
        isActive: true,
        date: candidateDateIso,
        patientId: therapy.pit.teaProfile.patient.id,
      },
      select: { id: true, time: true, durationMinutes: true },
    }),
    prisma.teaPreReservation.findMany({
      where: {
        status: { in: [...OPEN_STATUSES] as any },
        suggestedDate: { gte: dayStart, lte: dayEnd },
        patientId: therapy.pit.teaProfile.patient.id,
      },
      select: { id: true, suggestedTime: true, durationMinutes: true },
    }),
  ]);

  for (const doctor of candidateDoctors) {
    const doctorWindows = getDoctorWindowsForWeekday(doctor, weekdayToken);
    const fitsAnyWindow = doctorWindows.some((window) => (
      fitsDoctorWorkingWindow(suggestedTime, durationMinutes, window.hoursStart, window.hoursEnd)
    ));
    if (!fitsAnyWindow) continue;

    const [doctorAppointments, doctorReservations] = await Promise.all([
      prisma.appointment.findMany({
        where: {
          isActive: true,
          date: candidateDateIso,
          doctorName: doctor.name,
        },
        select: { id: true, time: true, durationMinutes: true },
      }),
      prisma.teaPreReservation.findMany({
        where: {
          status: { in: [...OPEN_STATUSES] as any },
          suggestedDate: { gte: dayStart, lte: dayEnd },
          professionalDoctorId: doctor.id,
        },
        select: { id: true, suggestedTime: true, durationMinutes: true },
      }),
    ]);

    const appointmentConflict = [...doctorAppointments, ...patientAppointments].find((item: any) => (
      item?.time && timeRangesOverlap(suggestedTime, durationMinutes, String(item.time), item.durationMinutes)
    ));
    const preReservationConflict = [...doctorReservations, ...patientReservations].find((item: any) => (
      item?.suggestedTime && timeRangesOverlap(suggestedTime, durationMinutes, String(item.suggestedTime), item.durationMinutes)
    ));

    if (appointmentConflict || preReservationConflict) {
      continue;
    }

    return {
      professionalDoctorId: doctor.id,
      professionalName: doctor.name,
    };
  }

  return null;
}

function buildSeriesDatesFromWeekdays(startDateIso: string, preferredWeekdays: string[], count: number): string[] {
  const safeCount = Math.max(0, Number(count) || 0);
  if (safeCount === 0) return [];

  const normalizedWeekdays = Array.from(new Set(
    preferredWeekdays
      .map((item) => normalizeWeekdayToken(item))
      .filter(Boolean) as string[],
  ));

  const weekdayIndexes = normalizedWeekdays
    .map((token) => PIT_WEEKDAY_TO_JS_DAY[token])
    .filter((index) => Number.isInteger(index));

  if (!weekdayIndexes.length) {
    return Array.from({ length: safeCount }).map((_, index) => {
      const candidate = new Date(`${startDateIso}T00:00:00`);
      candidate.setDate(candidate.getDate() + (index * 7));
      return formatDateAsIso(candidate);
    });
  }

  const dateCursor = new Date(`${startDateIso}T00:00:00`);
  if (Number.isNaN(dateCursor.getTime())) {
    return [];
  }

  const result: string[] = [];
  while (result.length < safeCount) {
    const currentIso = formatDateAsIso(dateCursor);
    const weekday = dateCursor.getDay();
    if (weekdayIndexes.includes(weekday)) {
      result.push(currentIso);
    }
    dateCursor.setDate(dateCursor.getDate() + 1);
  }

  return result;
}

function normalizeStatus(value?: string):
  | 'PENDING_SCHEDULING'
  | 'PROPOSED'
  | 'RESERVED'
  | 'PENDING_AUTHORIZATION'
  | 'AUTHORIZED'
  | 'CONVERTED'
  | 'EXPIRED'
  | 'CANCELED'
  | undefined {
  if (!value) return undefined;
  const normalized = String(value).toUpperCase().trim();

  if (
    normalized === 'PENDING_SCHEDULING'
    || normalized === 'PROPOSED'
    || normalized === 'RESERVED'
    || normalized === 'PENDING_AUTHORIZATION'
    || normalized === 'AUTHORIZED'
    || normalized === 'CONVERTED'
    || normalized === 'EXPIRED'
    || normalized === 'CANCELED'
  ) {
    return normalized;
  }

  return undefined;
}

function getExpiryMetadata(expiresAt?: Date | null, status?: string | null) {
  if (!expiresAt) {
    return {
      expiresAt: null,
      isExpired: false,
      isExpiringSoon: false,
      expiresInHours: null as number | null,
    };
  }

  const now = new Date();
  const deltaMs = expiresAt.getTime() - now.getTime();
  const expiresInHours = Math.floor(deltaMs / (1000 * 60 * 60));
  const isAlreadyClosed = status === 'CONVERTED' || status === 'CANCELED';

  return {
    expiresAt,
    isExpired: !isAlreadyClosed && deltaMs < 0,
    isExpiringSoon: !isAlreadyClosed && deltaMs >= 0 && deltaMs <= (48 * 60 * 60 * 1000),
    expiresInHours,
  };
}

function resolveActorFromRequest(request: any): string {
  const user = request?.user as any;
  return String(user?.name || user?.email || user?.id || 'SYSTEM');
}

function parseTimeToSortableValue(value?: string | null): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const [h, m] = String(value).split(':').map((part) => Number(part));
  const hour = Number.isFinite(h) ? h : 0;
  const minute = Number.isFinite(m) ? m : 0;
  return (hour * 60) + minute;
}

function pickPendingRepresentativeReservation(reservations: any[]): any | null {
  if (!Array.isArray(reservations) || reservations.length === 0) return null;

  const openReservations = reservations.filter((item) => OPEN_STATUSES.includes(String(item?.status || '') as any));

  if (openReservations.length > 0) {
    const withDate = openReservations.filter((item) => item?.suggestedDate);
    if (withDate.length > 0) {
      const orderedOpen = [...withDate].sort((a, b) => {
        const dateA = new Date(a.suggestedDate).getTime();
        const dateB = new Date(b.suggestedDate).getTime();
        if (dateA !== dateB) return dateA - dateB;
        return parseTimeToSortableValue(a.suggestedTime) - parseTimeToSortableValue(b.suggestedTime);
      });
      return orderedOpen[0];
    }

    const orderedOpenByCreation = [...openReservations].sort((a, b) => {
      const createdA = new Date(a.createdAt).getTime();
      const createdB = new Date(b.createdAt).getTime();
      return createdB - createdA;
    });
    return orderedOpenByCreation[0];
  }

  const orderedFallback = [...reservations].sort((a, b) => {
    const createdA = new Date(a.createdAt).getTime();
    const createdB = new Date(b.createdAt).getTime();
    return createdB - createdA;
  });
  return orderedFallback[0];
}

async function hasPendingFrequencyIncreaseForTherapy(pitTherapyId: string, branchId: string): Promise<boolean> {
  const therapy = await prisma.teaPitTherapy.findFirst({
    where: {
      id: pitTherapyId,
      isActive: true,
      pit: { teaProfile: { patient: { branchId } } },
    },
    include: {
      pit: {
        include: {
          teaProfile: {
            include: {
              patient: { select: { id: true } },
            },
          },
        },
      },
    },
  });

  if (!therapy) return false;

  const patientId = String(therapy?.pit?.teaProfile?.patient?.id || '');
  if (!patientId) return false;

  const todayIso = formatDateAsIso(new Date());
  const [convertedReservations, activeTeaAppointments] = await Promise.all([
    prisma.teaPreReservation.findMany({
      where: {
        pitTherapyId,
        status: 'CONVERTED' as any,
      },
      select: {
        suggestedDate: true,
        suggestedTime: true,
      },
    }),
    prisma.appointment.findMany({
      where: {
        isActive: true,
        type: 'RETORNO TEA',
        patientId,
        date: { gte: todayIso },
        NOT: [
          { status: 'CANCELED' },
          { status: 'CANCELADO' },
          { status: 'COMPLETED' },
          { status: 'CONCLUIDO' },
        ],
      },
      select: {
        date: true,
        time: true,
      },
    }),
  ]);

  const appointmentSignature = new Set(
    activeTeaAppointments
      .filter((item: any) => item?.date && item?.time)
      .map((item: any) => `${String(item.date)}#${String(item.time)}`),
  );

  const activeConvertedSlotSignatures = new Set<string>();
  convertedReservations.forEach((item: any) => {
    const dateIso = item?.suggestedDate ? formatDateAsIso(new Date(item.suggestedDate)) : null;
    const time = item?.suggestedTime ? String(item.suggestedTime) : null;
    if (!dateIso || !time) return;
    const slotSignature = `${dateIso}#${time}`;
    if (appointmentSignature.has(slotSignature)) {
      activeConvertedSlotSignatures.add(slotSignature);
    }
  });

  if (activeConvertedSlotSignatures.size === 0) return false;

  const slotsByWeek = new Map<string, Set<string>>();
  activeConvertedSlotSignatures.forEach((slotSignature) => {
    const [dateIso] = slotSignature.split('#');
    if (!dateIso) return;
    const weekStart = startOfWeekMonday(new Date(`${dateIso}T00:00:00`));
    const weekKey = formatDateAsIso(weekStart);
    if (!slotsByWeek.has(weekKey)) slotsByWeek.set(weekKey, new Set<string>());
    slotsByWeek.get(weekKey)!.add(slotSignature);
  });

  const activeWeeklyReference = Array.from(slotsByWeek.values())
    .map((weekSlots) => weekSlots.size)
    .reduce((max, count) => Math.max(max, Math.max(0, Number(count) || 0)), 0);
  const weeklyTarget = Math.max(1, Number(therapy?.weeklyFrequency) || 1);

  return activeWeeklyReference > 0 && activeWeeklyReference < weeklyTarget;
}

export default async function teaPreReservationsRoutes(app: FastifyInstance) {
  const getLoggedBranchId = async (request: any) => {
    const userId = (request.user as any)?.id;
    if (!userId) return null;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });
    return user?.sector?.branch?.id || null;
  };

  app.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });
    (request as any).branchId = branchId;
  });

  const expireOverdueReservations = async () => {
    const now = new Date();
    const overdueItems = await prisma.teaPreReservation.findMany({
      where: {
        status: {
          in: ['PROPOSED', 'RESERVED', 'PENDING_AUTHORIZATION', 'AUTHORIZED'] as any,
        },
        expiresAt: {
          not: null,
          lt: now,
        },
      },
      select: { id: true },
      take: 300,
    });

    if (overdueItems.length === 0) return;

    const overdueIds = overdueItems.map((item: { id: string }) => item.id);

    await prisma.$transaction(async (tx: any) => {
      await tx.teaPreReservation.updateMany({
        where: { id: { in: overdueIds } },
        data: { status: 'EXPIRED' },
      });

      await tx.teaPreReservationTimeline.createMany({
        data: overdueIds.map((id: string) => ({
          preReservationId: id,
          eventType: 'AUTO_EXPIRED',
          eventLabel: 'Pré-reserva expirada automaticamente',
          actor: 'SYSTEM',
        })),
      });
    });
  };

  const appendTimelineEvent = async (
    preReservationId: string,
    eventType: string,
    eventLabel: string,
    actor: string,
    payload?: Record<string, any>,
  ) => {
    await prisma.teaPreReservationTimeline.create({
      data: {
        preReservationId,
        eventType,
        eventLabel,
        actor,
        payload: payload || null,
      },
    });
  };

  app.get('/pending', {
    schema: {
      summary: 'List pre-reservation pending items generated from PIT + existing proposals',
      tags: ['TeaPreReservations'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          status: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    // verify prisma client has expected models
    if (!prisma || !prisma.teaPitTherapy || !prisma.teaPreReservation) {
      request.log.error({ keys: prisma ? Object.keys(prisma) : [] }, 'Prisma client missing models on pending route');
      return reply.code(500).send({ error: 'Server misconfiguration: prisma models unavailable' });
    }
    await expireOverdueReservations();

    const { search, status } = request.query as { search?: string; status?: string };
    const normalizedStatus = normalizeStatus(status);

    const therapies = await prisma.teaPitTherapy.findMany({
      where: {
        isActive: true,
        pit: {
          status: { not: 'Inativo' },
          teaProfile: {
            isActive: true,
          },
        },
      },
      include: {
        pit: {
          select: {
            id: true,
            teaProfileId: true,
            teaProfile: {
              select: {
                patientId: true,
                patient: {
                  select: {
                    id: true,
                    name: true,
                    cpf: true,
                    birthDate: true,
                    hasHealthInsurance: true,
                    healthInsuranceName: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const removedTherapies = await prisma.teaPitTherapy.findMany({
      where: {
        isActive: false,
        pit: {
          status: { not: 'Inativo' },
          teaProfile: {
            isActive: true,
          },
        },
      },
      include: {
        pit: {
          select: {
            id: true,
            teaProfileId: true,
            teaProfile: {
              select: {
                patientId: true,
                patient: {
                  select: {
                    id: true,
                    name: true,
                    cpf: true,
                    birthDate: true,
                    hasHealthInsurance: true,
                    healthInsuranceName: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 1000,
    });

    const removedTherapyBySignature = new Map<string, any>();
    removedTherapies.forEach((therapy: any) => {
      const signature = `${String(therapy?.pitId || '')}#${String(therapy?.procedureId || therapy?.therapyType || '').trim().toLowerCase()}#${String(therapy?.professionalDoctorId || therapy?.professional || '').trim().toLowerCase()}`;
      const current = removedTherapyBySignature.get(signature);
      if (!current) {
        removedTherapyBySignature.set(signature, therapy);
        return;
      }

      const currentUpdatedAt = current?.updatedAt ? new Date(current.updatedAt).getTime() : 0;
      const nextUpdatedAt = therapy?.updatedAt ? new Date(therapy.updatedAt).getTime() : 0;
      if (nextUpdatedAt >= currentUpdatedAt) {
        removedTherapyBySignature.set(signature, therapy);
      }
    });
    const dedupedRemovedTherapies = Array.from(removedTherapyBySignature.values());

    const therapyIds = therapies.map((item: any) => item.id);
    const removedTherapyIds = dedupedRemovedTherapies.map((item: any) => item.id);

    const reservations = (therapyIds.length > 0 || removedTherapyIds.length > 0)
      ? await prisma.teaPreReservation.findMany({
        where: {
          pitTherapyId: { in: [...therapyIds, ...removedTherapyIds] },
        },
      })
      : [];

    const authorizationAttachments = (therapyIds.length > 0 || removedTherapyIds.length > 0)
      ? await prisma.convenioAuthorizationAttachment.findMany({
        where: {
          branchId: (request as any).branchId as string,
          isActive: true,
          sourceType: 'TEA',
          pitTherapyId: { in: [...therapyIds, ...removedTherapyIds] },
        },
        orderBy: { uploadedAt: 'desc' },
      })
      : [];
    const attachmentsByTherapyId = new Map<string, any[]>();
    authorizationAttachments.forEach((item: any) => {
      const key = String(item?.pitTherapyId || '');
      if (!key) return;
      if (!attachmentsByTherapyId.has(key)) attachmentsByTherapyId.set(key, []);
      attachmentsByTherapyId.get(key)!.push(item);
    });

    const reservationsByTherapyId: Record<string, any[]> = {};
    for (const reservation of reservations) {
      const key = String(reservation.pitTherapyId || '');
      if (!key) continue;
      if (!reservationsByTherapyId[key]) reservationsByTherapyId[key] = [];
      reservationsByTherapyId[key].push(reservation);
    }

    const patientIds = Array.from(
      new Set(
        [...therapies, ...removedTherapies]
          .map((therapy: any) => String(therapy?.pit?.teaProfile?.patient?.id || '').trim())
          .filter(Boolean),
      ),
    );
    const todayIso = formatDateAsIso(new Date());
    const activeTeaAppointments = patientIds.length > 0
      ? await prisma.appointment.findMany({
        where: {
          isActive: true,
          type: 'RETORNO TEA',
          patientId: { in: patientIds },
          date: { gte: todayIso },
          NOT: [
            { status: 'CANCELED' },
            { status: 'CANCELADO' },
            { status: 'COMPLETED' },
            { status: 'CONCLUIDO' },
          ],
        },
        select: {
          patientId: true,
          date: true,
          time: true,
          doctorName: true,
          specialty: true,
        },
      })
      : [];
    const activeTeaAppointmentSignature = new Set(
      activeTeaAppointments
        .filter((item: any) => item?.patientId && item?.date && item?.time)
        .map((item: any) => [
          String(item.patientId),
          String(item.date),
          String(item.time),
          normalizeComparableText(item.doctorName),
          normalizeComparableText(item.specialty),
        ].join('#')),
    );

    const items = therapies.map((therapy: any) => {
      const resolveWeeklyCoverageCount = (counts: number[]) => {
        if (!counts.length) return 0;
        return counts.reduce((max, count) => Math.max(max, Math.max(0, Number(count) || 0)), 0);
      };

      const therapyReservations = reservationsByTherapyId[therapy.id] || [];
      const latest = pickPendingRepresentativeReservation(therapyReservations) || null;
      const latestStatus = latest?.status ? String(latest.status) : null;
      const hasOpenReservation = latestStatus && OPEN_STATUSES.includes(latestStatus as any);
      const hasAnyReservation = Boolean(latest);
      const patientId = String(therapy?.pit?.teaProfile?.patient?.id || '');
      const convertedReservations = therapyReservations.filter((item: any) => String(item?.status || '') === 'CONVERTED');
      const activeConvertedSlotSignatures = new Set<string>();
      convertedReservations.forEach((item: any) => {
        const dateIso = item?.suggestedDate ? formatDateAsIso(new Date(item.suggestedDate)) : null;
        const time = item?.suggestedTime ? String(item.suggestedTime) : null;
        if (!patientId || !dateIso || !time) return;
        const signature = [
          patientId,
          dateIso,
          time,
          normalizeComparableText(item?.professionalName),
          normalizeComparableText(item?.procedureName),
        ].join('#');
        if (activeTeaAppointmentSignature.has(signature)) {
          activeConvertedSlotSignatures.add(`${dateIso}#${time}`);
        }
      });
      const hasFutureActiveConvertedSessions = activeConvertedSlotSignatures.size > 0;

      const slotsByWeek = new Map<string, Set<string>>();
      activeConvertedSlotSignatures.forEach((slotSignature) => {
        const [dateIso] = slotSignature.split('#');
        if (!dateIso) return;
        const weekStart = startOfWeekMonday(new Date(`${dateIso}T00:00:00`));
        const weekKey = formatDateAsIso(weekStart);
        if (!slotsByWeek.has(weekKey)) slotsByWeek.set(weekKey, new Set<string>());
        slotsByWeek.get(weekKey)!.add(slotSignature);
      });

      const weeklyCounts = Array.from(slotsByWeek.values()).map((weekSlots) => weekSlots.size).filter((count) => count > 0);
      const activeWeeklyReference = resolveWeeklyCoverageCount(weeklyCounts);
      const weeklyTarget = Math.max(1, Number(therapy?.weeklyFrequency) || 1);
      const openReservations = therapyReservations.filter((item: any) => OPEN_STATUSES.includes(String(item?.status || '') as any));
      const weeklyPatternBySignature = new Map<string, { date: string; time: string }>();
      const upsertWeeklyPatternSlot = (dateIso: string | null, time: string | null) => {
        if (!dateIso || !time) return;
        const rawDate = new Date(`${dateIso}T00:00:00`);
        if (Number.isNaN(rawDate.getTime())) return;
        const weekday = rawDate.getDay();
        const signature = `${weekday}#${time}`;
        const existing = weeklyPatternBySignature.get(signature);
        if (!existing || dateIso < existing.date) {
          weeklyPatternBySignature.set(signature, { date: dateIso, time });
        }
      };

      openReservations.forEach((item: any) => {
        const rawDate = item?.suggestedDate ? new Date(item.suggestedDate) : null;
        const dateIso = rawDate && !Number.isNaN(rawDate.getTime()) ? formatDateAsIso(rawDate) : null;
        const time = item?.suggestedTime ? String(item.suggestedTime) : null;
        upsertWeeklyPatternSlot(dateIso, time);
      });

      // Frequency-change flow may have no open pre-reservations. In this case,
      // derive weekly anchors from converted sessions that still exist as active appointments.
      if (weeklyPatternBySignature.size === 0) {
        activeConvertedSlotSignatures.forEach((slotSignature) => {
          const [dateIso, time] = String(slotSignature).split('#');
          upsertWeeklyPatternSlot(dateIso || null, time || null);
        });
      }

      const weeklySlotPattern = Array.from(weeklyPatternBySignature.values()).sort((a, b) => {
        const weekdayA = new Date(`${a.date}T00:00:00`).getDay();
        const weekdayB = new Date(`${b.date}T00:00:00`).getDay();
        if (weekdayA !== weekdayB) return weekdayA - weekdayB;
        return parseTimeToSortableValue(a.time) - parseTimeToSortableValue(b.time);
      });
      const openSlotsByWeek = new Map<string, Set<string>>();
      openReservations.forEach((item: any) => {
        const dateIso = item?.suggestedDate ? formatDateAsIso(new Date(item.suggestedDate)) : null;
        const time = item?.suggestedTime ? String(item.suggestedTime) : null;
        if (!dateIso || !time) return;
        const weekStart = startOfWeekMonday(new Date(`${dateIso}T00:00:00`));
        const weekKey = formatDateAsIso(weekStart);
        if (!openSlotsByWeek.has(weekKey)) openSlotsByWeek.set(weekKey, new Set<string>());
        openSlotsByWeek.get(weekKey)!.add(`${dateIso}#${time}`);
      });
      const openWeeklyCounts = Array.from(openSlotsByWeek.values())
        .map((weekSlots) => weekSlots.size)
        .filter((count) => count > 0);
      const openWeeklyReference = resolveWeeklyCoverageCount(openWeeklyCounts);
      const isWeeklyReservationComplete = openWeeklyReference >= weeklyTarget;
      const lastConvertedAt = convertedReservations.reduce((latestDate: Date | null, item: any) => {
        const convertedAt = item?.convertedAt ? new Date(item.convertedAt) : null;
        if (!convertedAt || Number.isNaN(convertedAt.getTime())) return latestDate;
        if (!latestDate || convertedAt.getTime() > latestDate.getTime()) return convertedAt;
        return latestDate;
      }, null as Date | null);
      const pitUpdatedAt = therapy?.updatedAt ? new Date(therapy.updatedAt) : null;
      const pitChangedAfterLastConversion = Boolean(
        lastConvertedAt
        && pitUpdatedAt
        && !Number.isNaN(pitUpdatedAt.getTime())
        && pitUpdatedAt.getTime() > lastConvertedAt.getTime(),
      );
      const hasWeeklyFrequencyDelta = hasFutureActiveConvertedSessions
        && pitChangedAfterLastConversion
        && activeWeeklyReference > 0
        && activeWeeklyReference !== weeklyTarget;

      const treatAsPendingScheduling = !hasOpenReservation && (!hasFutureActiveConvertedSessions || hasWeeklyFrequencyDelta);

      const patientName = therapy.pit?.teaProfile?.patient?.name || 'Paciente sem nome';
      const patientCpf = therapy.pit?.teaProfile?.patient?.cpf || null;
      const hasConvenio = Boolean(
        therapy?.pit?.teaProfile?.patient?.hasHealthInsurance
        || String(therapy?.pit?.teaProfile?.patient?.healthInsuranceName || '').trim(),
      );
      const procedureName = therapy.therapyType || latest?.procedureName || null;
      const professionalName = therapy.professional || latest?.professionalName || null;
      const authorizationDocs = attachmentsByTherapyId.get(String(therapy.id)) || [];

      const effectiveStatus = treatAsPendingScheduling
        ? (hasWeeklyFrequencyDelta ? 'RESERVED' : 'PENDING_SCHEDULING')
        : (hasAnyReservation ? String(latest.status) : 'PENDING_SCHEDULING');
      const expiryMetadata = getExpiryMetadata(treatAsPendingScheduling ? null : (latest?.expiresAt || null), effectiveStatus);

      return {
        preReservationId: treatAsPendingScheduling ? null : (hasAnyReservation ? latest.id : null),
        status: effectiveStatus,
        patient: {
          id: therapy.pit?.teaProfile?.patient?.id || null,
          name: patientName,
          cpf: patientCpf,
        },
        teaProfileId: therapy.pit.teaProfileId,
        pitId: therapy.pitId,
        pitTherapyId: therapy.id,
        procedure: {
          id: therapy.procedureId || latest?.procedureId || null,
          name: procedureName,
          durationMinutes: therapy.durationMinutes ?? latest?.durationMinutes ?? null,
        },
        professional: {
          id: therapy.professionalDoctorId || latest?.professionalDoctorId || null,
          name: professionalName,
        },
        preferences: {
          weeklyFrequency: therapy.weeklyFrequency,
          weekdays: therapy.preferredWeekdays,
          shift: therapy.preferredShift,
        },
        weeklyReservationCount: openWeeklyReference,
        isWeeklyReservationComplete,
        slotSuggestion: {
          suggestedDate: !treatAsPendingScheduling && hasAnyReservation ? latest?.suggestedDate : null,
          suggestedTime: !treatAsPendingScheduling && hasAnyReservation ? latest?.suggestedTime : null,
        },
        weeklySlotPattern,
        notes: !treatAsPendingScheduling && hasAnyReservation ? latest?.notes : null,
        authorizationAttachmentsCount: authorizationDocs.length,
        authorizationAttachments: authorizationDocs.slice(0, 5).map((doc: any) => ({
          id: doc.id,
          fileName: doc.fileName,
          uploadedAt: doc.uploadedAt,
        })),
        source: hasWeeklyFrequencyDelta
          ? 'PIT_PENDING_FREQUENCY_CHANGE'
          : (!treatAsPendingScheduling && hasAnyReservation ? 'PRE_RESERVATION' : 'PIT_PENDING'),
        expiresAt: expiryMetadata.expiresAt,
        isExpired: expiryMetadata.isExpired,
        isExpiringSoon: expiryMetadata.isExpiringSoon,
        expiresInHours: expiryMetadata.expiresInHours,
        ...(hasWeeklyFrequencyDelta
          ? {
            alertMessage: `Frequência semanal alterada de ${activeWeeklyReference}x para ${weeklyTarget}x. É necessário refazer a reserva.`,
            previousWeeklyFrequency: activeWeeklyReference,
            currentWeeklyFrequency: weeklyTarget,
          }
          : {}),
        approvalRequestedAt: !treatAsPendingScheduling && hasAnyReservation && effectiveStatus === 'PROPOSED'
          ? (latest?.updatedAt || latest?.createdAt || null)
          : null,
        approvalDeadlineAt: !treatAsPendingScheduling && hasAnyReservation && effectiveStatus === 'PROPOSED'
          ? (latest?.expiresAt || null)
          : null,
      };
    });

    const activeTherapySignatureSet = new Set(
      items.map((item: any) => {
        return buildTherapyComparableSignature({
          teaProfileId: item?.teaProfileId,
          patientId: item?.patient?.id,
          procedureId: item?.procedure?.id,
          procedureName: item?.procedure?.name,
          professionalId: item?.professional?.id,
          professionalName: item?.professional?.name,
        });
      }),
    );

    const removedTherapyPendingItems = dedupedRemovedTherapies
      .map((therapy: any) => {
        const therapyReservations = reservationsByTherapyId[therapy.id] || [];
        const convertedReservations = therapyReservations.filter((item: any) => String(item?.status || '') === 'CONVERTED');
        if (convertedReservations.length === 0) return null;

        const removedTherapySignature = buildTherapyComparableSignature({
          teaProfileId: therapy?.pit?.teaProfileId,
          patientId: therapy?.pit?.teaProfile?.patient?.id,
          procedureId: therapy?.procedureId,
          procedureName: therapy?.therapyType,
          professionalId: therapy?.professionalDoctorId,
          professionalName: therapy?.professional,
        });
        if (activeTherapySignatureSet.has(removedTherapySignature)) {
          return null;
        }

        const patientId = String(therapy?.pit?.teaProfile?.patient?.id || '');
        const hasFutureActiveConvertedSessions = convertedReservations.some((item: any) => {
          const dateIso = item?.suggestedDate ? formatDateAsIso(new Date(item.suggestedDate)) : null;
          const time = item?.suggestedTime ? String(item.suggestedTime) : null;
          if (!patientId || !dateIso || !time) return false;
          const signature = [
            patientId,
            dateIso,
            time,
            normalizeComparableText(item?.professionalName),
            normalizeComparableText(item?.procedureName),
          ].join('#');
          return activeTeaAppointmentSignature.has(signature);
        });

        if (!hasFutureActiveConvertedSessions) return null;

        const patientName = therapy.pit?.teaProfile?.patient?.name || 'Paciente sem nome';
        const patientCpf = therapy.pit?.teaProfile?.patient?.cpf || null;
        const authorizationDocs = attachmentsByTherapyId.get(String(therapy.id)) || [];

        return {
          preReservationId: null,
          status: 'PENDING_SCHEDULING',
          patient: {
            id: therapy.pit?.teaProfile?.patient?.id || null,
            name: patientName,
            cpf: patientCpf,
          },
          teaProfileId: therapy.pit.teaProfileId,
          pitId: therapy.pitId,
          pitTherapyId: therapy.id,
          procedure: {
            id: therapy.procedureId || null,
            name: therapy.therapyType || null,
            durationMinutes: therapy.durationMinutes ?? null,
          },
          professional: {
            id: therapy.professionalDoctorId || null,
            name: therapy.professional || null,
          },
          preferences: {
            weeklyFrequency: therapy.weeklyFrequency,
            weekdays: therapy.preferredWeekdays,
            shift: therapy.preferredShift,
          },
          slotSuggestion: {
            suggestedDate: null,
            suggestedTime: null,
          },
          notes: null,
          authorizationAttachmentsCount: authorizationDocs.length,
          authorizationAttachments: authorizationDocs.slice(0, 5).map((doc: any) => ({
            id: doc.id,
            fileName: doc.fileName,
            uploadedAt: doc.uploadedAt,
          })),
          source: 'PIT_REMOVED_THERAPY',
          removedFromPit: true,
          requiresUnschedule: true,
          alertMessage: 'Terapia removida do PIT com sessões ainda ativas. Desmarque as sessões desta terapia.',
          expiresAt: null,
          isExpired: false,
          isExpiringSoon: false,
          expiresInHours: null,
          approvalRequestedAt: null,
          approvalDeadlineAt: null,
        };
      })
      .filter(Boolean) as any[];

    let filtered = [...items, ...removedTherapyPendingItems];

    if (normalizedStatus) {
      filtered = filtered.filter((item: any) => item.status === normalizedStatus);
    }

    if (search) {
      const query = String(search).toLowerCase();
      filtered = filtered.filter((item: any) => {
        const candidate = [
          item.patient?.name || '',
          item.patient?.cpf || '',
          item.procedure?.name || '',
          item.professional?.name || '',
        ].join(' ').toLowerCase();

        return candidate.includes(query);
      });
    }

    return {
      items: filtered,
      total: filtered.length,
      summary: {
        totalPendingScheduling: filtered.filter((item: any) => item.status === 'PENDING_SCHEDULING').length,
        totalPendingAuthorization: filtered.filter((item: any) => item.status === 'PENDING_AUTHORIZATION').length,
        totalAuthorized: filtered.filter((item: any) => item.status === 'AUTHORIZED').length,
      },
    };
  });

  app.get('/:pitTherapyId/suggestions', {
    schema: {
      summary: 'Get automatic slot suggestions for pre-reservation based on PIT + doctor agenda',
      tags: ['TeaPreReservations'],
      params: {
        type: 'object',
        properties: { pitTherapyId: { type: 'string' } },
        required: ['pitTherapyId'],
      },
      querystring: {
        type: 'object',
        properties: {
          daysAhead: { type: 'number', default: 21 },
          limit: { type: 'number', default: 5 },
          exclude: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { pitTherapyId } = request.params as { pitTherapyId: string };
    const { daysAhead = 21, limit = 5, exclude } = request.query as {
      daysAhead?: number;
      limit?: number;
      exclude?: string;
    };
    const excludedSlots = new Set(
      String(exclude || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );

    const therapy = await prisma.teaPitTherapy.findFirst({
      where: { id: pitTherapyId, pit: { teaProfile: { patient: { branchId: (request as any).branchId as string } } } },
      include: {
        pit: {
          include: {
            teaProfile: {
              include: {
                patient: {
                  select: { id: true, name: true, cpf: true },
                },
              },
            },
          },
        },
      },
    });

    if (!therapy || !therapy.isActive) {
      return reply.code(404).send({ error: 'PIT therapy not found or inactive' });
    }

    const branchId = (request as any).branchId as string;
    const candidateDoctors = await listCandidateDoctorsForTherapy(therapy, branchId);
    if (!candidateDoctors.length) {
      return {
        items: [],
        total: 0,
        context: {
          pitTherapyId,
          doctorId: null,
          doctorName: null,
          preferredWeekdays: Array.isArray(therapy.preferredWeekdays) ? therapy.preferredWeekdays : [],
          preferredShift: therapy.preferredShift,
        },
      };
    }

    const preferredWeekdays = Array.isArray(therapy.preferredWeekdays)
      ? therapy.preferredWeekdays
        .map((item: any) => normalizeWeekdayToken(item))
        .filter(Boolean) as string[]
      : [];

    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const monday = startOfWeekMonday(now);
    const daysSinceMonday = Math.max(0, Math.floor((now.getTime() - monday.getTime()) / (24 * 60 * 60 * 1000)));
    const totalOffsets = Math.max(daysAhead, 1) + daysSinceMonday;

    const candidateDateStringsByDoctor = candidateDoctors.map((doctor) => {
      const preferredCandidateDateStrings: string[] = [];
      const fallbackCandidateDateStrings: string[] = [];

      for (let offset = 0; offset <= totalOffsets; offset += 1) {
        const date = new Date(monday);
        date.setHours(0, 0, 0, 0);
        date.setDate(monday.getDate() + offset);

        const weekdayToken = JS_DAY_TO_PIT_WEEKDAY[date.getDay()];
        const doctorWindows = getDoctorWindowsForWeekday(doctor, weekdayToken);
        if (doctorWindows.length === 0) continue;

        const isoDate = formatDateAsIso(date);
        const isPreferredWeekday = preferredWeekdays.length > 0 && preferredWeekdays.includes(weekdayToken);
        if (isPreferredWeekday) {
          preferredCandidateDateStrings.push(isoDate);
        } else {
          fallbackCandidateDateStrings.push(isoDate);
        }
      }

      return {
        doctor,
        candidateDateStrings: preferredWeekdays.length > 0
          ? [...preferredCandidateDateStrings, ...fallbackCandidateDateStrings]
          : [...fallbackCandidateDateStrings],
      };
    }).filter((entry) => entry.candidateDateStrings.length > 0);

    const allCandidateDateStrings = Array.from(new Set(
      candidateDateStringsByDoctor.flatMap((entry) => entry.candidateDateStrings),
    ));

    if (allCandidateDateStrings.length === 0) {
      return {
        items: [],
        total: 0,
        context: {
          pitTherapyId,
          doctorId: null,
          doctorName: null,
        },
      };
    }

    const candidateDateRange = [...allCandidateDateStrings].sort((a, b) => a.localeCompare(b));
    const rangeStart = candidateDateRange[0];
    const rangeEnd = candidateDateRange[candidateDateRange.length - 1];
 
    const [patientAppointments, patientReservations] = await Promise.all([
      prisma.appointment.findMany({
        where: {
          isActive: true,
          patientId: therapy.pit.teaProfile.patient.id,
          date: { in: allCandidateDateStrings },
          NOT: [
            { status: 'CANCELED' },
            { status: 'CANCELADO' },
            { status: 'COMPLETED' },
            { status: 'CONCLUIDO' },
          ],
        },
        select: { date: true, time: true, durationMinutes: true },
      }),
      prisma.teaPreReservation.findMany({
        where: {
          patientId: therapy.pit.teaProfile.patient.id,
          status: { in: [...OPEN_STATUSES] as any },
          pit: { status: { not: 'Inativo' } },
          pitTherapy: { isActive: true },
          suggestedDate: {
            gte: new Date(`${rangeStart}T00:00:00`),
            lte: new Date(`${rangeEnd}T23:59:59`),
          },
        },
        select: { pitTherapyId: true, suggestedDate: true, suggestedTime: true, durationMinutes: true },
      }),
    ]);

    const patientOccupied = new Set<string>();

    [...patientAppointments].forEach((item: any) => {
      const date = String(item.date || '').trim();
      const time = String(item.time || '').trim();
      if (!date || !time) return;
      buildCoveredTimeSlots(time, item.durationMinutes).forEach((coveredTime) => {
        patientOccupied.add(`${date}#${coveredTime}`);
      });
    });

    [...patientReservations].forEach((item: any) => {
      const time = String(item?.suggestedTime || '').trim();
      const date = item?.suggestedDate ? formatDateAsIso(new Date(item.suggestedDate)) : '';
      if (!date || !time) return;

      // Do not block the therapy's own open slots during regeneration.
      if (String(item?.pitTherapyId || '') === String(therapy.id)) return;

      buildCoveredTimeSlots(time, item.durationMinutes).forEach((coveredTime) => {
        patientOccupied.add(`${date}#${coveredTime}`);
      });
    });

    const baseSlots = getShiftSlots(therapy.preferredShift);
    const slotDurationMinutes = resolveDurationMinutes(therapy.durationMinutes);

    const suggestions: Array<{
      date: string;
      time: string;
      doctorId: string;
      doctorName: string;
      procedureName: string | null;
    }> = [];
    const seenSuggestions = new Set<string>();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const entry of candidateDateStringsByDoctor) {
      const { doctor, candidateDateStrings } = entry;
      const [doctorAppointments, doctorReservations] = await Promise.all([
        prisma.appointment.findMany({
          where: {
            isActive: true,
            doctorName: doctor.name,
            date: { in: candidateDateStrings },
            NOT: [
              { status: 'CANCELED' },
              { status: 'CANCELADO' },
              { status: 'COMPLETED' },
              { status: 'CONCLUIDO' },
            ],
          },
          select: { date: true, time: true, durationMinutes: true },
        }),
        prisma.teaPreReservation.findMany({
          where: {
            professionalDoctorId: doctor.id,
            status: { in: [...OPEN_STATUSES] as any },
            pit: { status: { not: 'Inativo' } },
            pitTherapy: { isActive: true },
            suggestedDate: {
              gte: new Date(`${rangeStart}T00:00:00`),
              lte: new Date(`${rangeEnd}T23:59:59`),
            },
          },
          select: { pitTherapyId: true, suggestedDate: true, suggestedTime: true, durationMinutes: true },
        }),
      ]);

      const occupied = new Set<string>(patientOccupied);

      [...doctorAppointments].forEach((item: any) => {
        const date = String(item.date || '').trim();
        const time = String(item.time || '').trim();
        if (!date || !time) return;
        buildCoveredTimeSlots(time, item.durationMinutes).forEach((coveredTime) => {
          occupied.add(`${date}#${coveredTime}`);
        });
      });

      [...doctorReservations].forEach((item: any) => {
        const time = String(item?.suggestedTime || '').trim();
        const date = item?.suggestedDate ? formatDateAsIso(new Date(item.suggestedDate)) : '';
        if (!date || !time) return;
        if (String(item?.pitTherapyId || '') === String(therapy.id)) return;

        buildCoveredTimeSlots(time, item.durationMinutes).forEach((coveredTime) => {
          occupied.add(`${date}#${coveredTime}`);
        });
      });

      for (const date of candidateDateStrings) {
        const candidateDate = new Date(`${date}T00:00:00`);
        const weekdayToken = JS_DAY_TO_PIT_WEEKDAY[candidateDate.getDay()];
        const doctorWindows = getDoctorWindowsForWeekday(doctor, weekdayToken);
        const filteredSlots = baseSlots.filter((slot) => doctorWindows.some((window) => (
          fitsDoctorWorkingWindow(slot, slotDurationMinutes, window.hoursStart, window.hoursEnd)
        )));
        if (filteredSlots.length === 0) continue;
        const suggestionDateObj = new Date(candidateDate);
        while (suggestionDateObj.getTime() < today.getTime()) {
          suggestionDateObj.setDate(suggestionDateObj.getDate() + 7);
        }
        const suggestionIso = formatDateAsIso(suggestionDateObj);

        for (const time of filteredSlots) {
          const originalSignature = `${date}#${time}`;
          const suggestionSignature = `${suggestionIso}#${time}`;
          const suggestionKey = `${doctor.id}#${suggestionIso}#${time}`;
          if (occupied.has(originalSignature) || occupied.has(suggestionSignature)) continue;
          if (!canPlaceSessionAtSlot(date, time, slotDurationMinutes, occupied)) continue;
          if (!canPlaceSessionAtSlot(suggestionIso, time, slotDurationMinutes, occupied)) continue;
          if (excludedSlots.has(originalSignature) || excludedSlots.has(suggestionSignature)) continue;
          if (seenSuggestions.has(suggestionKey)) continue;

          seenSuggestions.add(suggestionKey);
          suggestions.push({
            date: suggestionIso,
            time,
            doctorId: doctor.id,
            doctorName: doctor.name,
            procedureName: therapy.therapyType || null,
          });
        }
      }
    }

    suggestions.sort((a, b) => {
      const dateDiff = a.date.localeCompare(b.date);
      if (dateDiff !== 0) return dateDiff;
      const timeDiff = a.time.localeCompare(b.time);
      if (timeDiff !== 0) return timeDiff;
      return a.doctorName.localeCompare(b.doctorName);
    });

    return {
      items: suggestions.slice(0, Math.max(limit, 1)),
      total: suggestions.length,
      context: {
        pitTherapyId,
        doctorId: candidateDoctors.length === 1 ? candidateDoctors[0].id : null,
        doctorName: candidateDoctors.length === 1 ? candidateDoctors[0].name : null,
        preferredWeekdays,
        preferredShift: therapy.preferredShift,
      },
    };
  });

  app.get('/:pitTherapyId/manual-grid', {
    schema: {
      summary: 'Get manual weekly calendar grid with occupied slots for PIT therapy',
      tags: ['TeaPreReservations'],
      params: {
        type: 'object',
        properties: { pitTherapyId: { type: 'string' } },
        required: ['pitTherapyId'],
      },
      querystring: {
        type: 'object',
        properties: {
          weekStart: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { pitTherapyId } = request.params as { pitTherapyId: string };
    const { weekStart } = request.query as { weekStart?: string };

    const therapy = await prisma.teaPitTherapy.findFirst({
      where: { id: pitTherapyId, pit: { teaProfile: { patient: { branchId: (request as any).branchId as string } } } },
      include: {
        pit: {
          include: {
            teaProfile: {
              include: {
                patient: {
                  select: { id: true, name: true, cpf: true },
                },
              },
            },
          },
        },
      },
    });

    if (!therapy || !therapy.isActive) {
      return reply.code(404).send({ error: 'PIT therapy not found or inactive' });
    }

    const branchId = (request as any).branchId as string;
    const candidateDoctors = await listCandidateDoctorsForTherapy(therapy, branchId);

    const parsedWeekStart = weekStart ? new Date(`${weekStart}T00:00:00`) : new Date();
    if (Number.isNaN(parsedWeekStart.getTime())) {
      return reply.code(400).send({ error: 'Invalid weekStart date. Use YYYY-MM-DD format.' });
    }

    const monday = startOfWeekMonday(parsedWeekStart);
    const weekDates = Array.from({ length: 7 }).map((_, idx) => {
      const date = new Date(monday);
      date.setDate(monday.getDate() + idx);
      return formatDateAsIso(date);
    });

    const preferredWeekdays = Array.isArray(therapy.preferredWeekdays)
      ? therapy.preferredWeekdays
        .map((item: any) => normalizeWeekdayToken(item))
        .filter(Boolean) as string[]
      : [];

    const [patientAppointments, patientReservations] = await Promise.all([
      prisma.appointment.findMany({
        where: {
          isActive: true,
          patientId: therapy.pit.teaProfile.patient.id,
          date: { in: weekDates },
          NOT: [
            { status: 'CANCELED' },
            { status: 'CANCELADO' },
            { status: 'COMPLETED' },
            { status: 'CONCLUIDO' },
          ],
        },
        select: { date: true, time: true, durationMinutes: true },
      }),
      prisma.teaPreReservation.findMany({
        where: {
          patientId: therapy.pit.teaProfile.patient.id,
          status: { in: [...OPEN_STATUSES] as any },
          pit: { status: { not: 'Inativo' } },
          pitTherapy: { isActive: true },
          suggestedDate: {
            gte: new Date(`${weekDates[0]}T00:00:00`),
            lte: new Date(`${weekDates[6]}T23:59:59`),
          },
        },
        select: { pitTherapyId: true, suggestedDate: true, suggestedTime: true, durationMinutes: true },
      }),
    ]);

    const patientOccupied = new Set<string>();

    [...patientAppointments].forEach((item: any) => {
      const date = String(item.date || '').trim();
      const time = String(item.time || '').trim();
      if (!date || !time) return;
      buildCoveredTimeSlots(time, item.durationMinutes).forEach((coveredTime) => {
        patientOccupied.add(`${date}#${coveredTime}`);
      });
    });

    [...patientReservations].forEach((item: any) => {
      const time = String(item?.suggestedTime || '').trim();
      const date = item?.suggestedDate ? formatDateAsIso(new Date(item.suggestedDate)) : '';
      if (!date || !time) return;

      // Keep the current therapy editable in the manual modal.
      if (String(item?.pitTherapyId || '') === String(therapy.id)) return;

      buildCoveredTimeSlots(time, item.durationMinutes).forEach((coveredTime) => {
        patientOccupied.add(`${date}#${coveredTime}`);
      });
    });

    const baseSlots = getShiftSlots(therapy.preferredShift);
    const slotDurationMinutes = resolveDurationMinutes(therapy.durationMinutes);

    const daySlotMap = new Map<string, Map<string, { time: string; occupied: boolean; selectable: boolean; doctorId?: string | null; doctorName?: string | null }>>();
    weekDates.forEach((date) => daySlotMap.set(date, new Map()));

    for (const doctor of candidateDoctors) {
      const [doctorAppointments, doctorReservations] = await Promise.all([
        prisma.appointment.findMany({
          where: {
            isActive: true,
            doctorName: doctor.name,
            date: { in: weekDates },
            NOT: [
              { status: 'CANCELED' },
              { status: 'CANCELADO' },
              { status: 'COMPLETED' },
              { status: 'CONCLUIDO' },
            ],
          },
          select: { date: true, time: true, durationMinutes: true },
        }),
        prisma.teaPreReservation.findMany({
          where: {
            professionalDoctorId: doctor.id,
            status: { in: [...OPEN_STATUSES] as any },
            pit: { status: { not: 'Inativo' } },
            pitTherapy: { isActive: true },
            suggestedDate: {
              gte: new Date(`${weekDates[0]}T00:00:00`),
              lte: new Date(`${weekDates[6]}T23:59:59`),
            },
          },
          select: { pitTherapyId: true, suggestedDate: true, suggestedTime: true, durationMinutes: true },
        }),
      ]);

      const occupied = new Set<string>(patientOccupied);

      [...doctorAppointments].forEach((item: any) => {
        const date = String(item.date || '').trim();
        const time = String(item.time || '').trim();
        if (!date || !time) return;
        buildCoveredTimeSlots(time, item.durationMinutes).forEach((coveredTime) => {
          occupied.add(`${date}#${coveredTime}`);
        });
      });

      [...doctorReservations].forEach((item: any) => {
        const time = String(item?.suggestedTime || '').trim();
        const date = item?.suggestedDate ? formatDateAsIso(new Date(item.suggestedDate)) : '';
        if (!date || !time) return;
        if (String(item?.pitTherapyId || '') === String(therapy.id)) return;

        buildCoveredTimeSlots(time, item.durationMinutes).forEach((coveredTime) => {
          occupied.add(`${date}#${coveredTime}`);
        });
      });

      weekDates.forEach((date) => {
        const weekdayToken = JS_DAY_TO_PIT_WEEKDAY[new Date(`${date}T00:00:00`).getDay()];
        const doctorWindows = getDoctorWindowsForWeekday(doctor, weekdayToken);
        if (doctorWindows.length === 0) return;

        const timeMap = daySlotMap.get(date);
        if (!timeMap) return;

        const daySlots = baseSlots.filter((slot) => doctorWindows.some((window) => (
          fitsDoctorWorkingWindow(slot, slotDurationMinutes, window.hoursStart, window.hoursEnd)
        )));

        daySlots.forEach((time) => {
          const selectable = canPlaceSessionAtSlot(date, time, slotDurationMinutes, occupied);
          const existing = timeMap.get(time);

          if (!existing) {
            timeMap.set(time, {
              time,
              occupied: !selectable,
              selectable,
              doctorId: selectable ? doctor.id : null,
              doctorName: selectable ? doctor.name : null,
            });
            return;
          }

          if (!existing.selectable && selectable) {
            timeMap.set(time, {
              time,
              occupied: false,
              selectable: true,
              doctorId: doctor.id,
              doctorName: doctor.name,
            });
          }
        });
      });
    }

    const days = weekDates.map((date) => {
      const weekdayToken = JS_DAY_TO_PIT_WEEKDAY[new Date(`${date}T00:00:00`).getDay()];
      const matchesPreferredWeekday = preferredWeekdays.length === 0 || preferredWeekdays.includes(weekdayToken);
      const slots = Array.from(daySlotMap.get(date)?.values() || []).sort((a, b) => (
        timeToMinutes(a.time) - timeToMinutes(b.time)
      ));

      return {
        date,
        weekday: weekdayToken,
        isPreferredWeekday: matchesPreferredWeekday,
        enabled: slots.length > 0,
        slots,
      };
    });

    return {
      context: {
        pitTherapyId,
        doctorId: candidateDoctors.length === 1 ? candidateDoctors[0]?.id : null,
        doctorName: candidateDoctors.length === 1 ? candidateDoctors[0]?.name : null,
        procedureName: therapy.therapyType || null,
        preferredWeekdays,
        preferredShift: therapy.preferredShift,
      },
      week: {
        startDate: weekDates[0],
        endDate: weekDates[6],
      },
      days,
    };
  });

  app.post('/', {
    schema: {
      summary: 'Create pre-reservation proposal from PIT therapy',
      tags: ['TeaPreReservations'],
      body: {
        type: 'object',
        required: ['pitTherapyId'],
        properties: {
          pitTherapyId: { type: 'string' },
          suggestedDate: { type: 'string' },
          suggestedTime: { type: 'string' },
          status: { type: 'string' },
          notes: { type: 'string' },
          expiresAt: { type: 'string' },
          recurring: { type: 'boolean' },
          recurrenceWeeks: { type: 'number' },
          recurringUntilDate: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as any;
    const actor = resolveActorFromRequest(request);

    const pitTherapyId = String(body?.pitTherapyId || '');
    if (!pitTherapyId) {
      return reply.code(400).send({ error: 'Validation failed', fields: { pitTherapyId: 'pitTherapyId é obrigatório' } });
    }

    const therapy = await prisma.teaPitTherapy.findFirst({
      where: { id: pitTherapyId, pit: { teaProfile: { patient: { branchId: (request as any).branchId as string } } } },
      include: {
        pit: {
          include: {
            teaProfile: {
              include: {
                patient: {
                  select: { id: true },
                },
              },
            },
          },
        },
      },
    });

    if (!therapy || !therapy.isActive) {
      return reply.code(404).send({ error: 'PIT therapy not found or inactive' });
    }

    const status = normalizeStatus(body?.status) || 'PROPOSED';

    const baseData = {
      teaProfileId: therapy.pit.teaProfileId,
      pitId: therapy.pitId,
      pitTherapyId: therapy.id,
      patientId: therapy.pit.teaProfile.patient.id,
      procedureId: therapy.procedureId || null,
      procedureName: therapy.therapyType || null,
      professionalDoctorId: therapy.professionalDoctorId || null,
      professionalName: therapy.professional || null,
      status,
      notes: body?.notes || null,
      expiresAt: body?.expiresAt ? new Date(body.expiresAt) : null,
    };

    const recurring = Boolean(body?.recurring);
    const requestDurationMinutes = resolveDurationMinutes(body?.durationMinutes ?? therapy.durationMinutes);
    if (!recurring) {
      if (body?.suggestedDate && body?.suggestedTime) {
        const candidateDate = new Date(body.suggestedDate);
        if (Number.isNaN(candidateDate.getTime())) {
          return reply.code(400).send({
            error: 'Validation failed',
            fields: { suggestedDate: 'Data sugerida inválida' },
          });
        }

        const candidateDateIso = formatDateAsIso(candidateDate);
        const dayStart = new Date(`${candidateDateIso}T00:00:00`);
        const dayEnd = new Date(`${candidateDateIso}T23:59:59`);
        const suggestedTime = String(body.suggestedTime);

        const [appointmentConflicts, preReservationConflicts] = await Promise.all([
          prisma.appointment.findMany({
            where: {
              isActive: true,
              date: candidateDateIso,
              OR: [
                { doctorName: therapy.professional || undefined },
                { patientId: therapy.pit.teaProfile.patient.id },
              ],
            },
            select: { id: true, time: true, durationMinutes: true },
          }),
          prisma.teaPreReservation.findMany({
            where: {
              status: { in: [...OPEN_STATUSES] as any },
              suggestedDate: {
                gte: dayStart,
                lte: dayEnd,
              },
              OR: [
                { professionalDoctorId: therapy.professionalDoctorId || undefined },
                { patientId: therapy.pit.teaProfile.patient.id },
              ],
            },
            select: { id: true, suggestedTime: true, durationMinutes: true },
          }),
        ]);

        const appointmentConflict = appointmentConflicts.find((item: any) => (
          item?.time && timeRangesOverlap(suggestedTime, requestDurationMinutes, String(item.time), item.durationMinutes)
        ));
        const preReservationConflict = preReservationConflicts.find((item: any) => (
          item?.suggestedTime && timeRangesOverlap(suggestedTime, requestDurationMinutes, String(item.suggestedTime), item.durationMinutes)
        ));

        if (appointmentConflict || preReservationConflict) {
          return reply.code(409).send({
            error: 'Conflito de horário detectado para paciente ou profissional',
          });
        }
      }

      const item = await prisma.teaPreReservation.create({
        data: {
          ...baseData,
          suggestedDate: body?.suggestedDate ? new Date(body.suggestedDate) : null,
          suggestedTime: body?.suggestedTime || null,
          durationMinutes: body?.suggestedDate && body?.suggestedTime ? requestDurationMinutes : null,
        },
      });

      await appendTimelineEvent(
        item.id,
        'CREATED',
        'Pré-reserva criada',
        actor,
        {
          status: item.status,
          suggestedDate: item.suggestedDate,
          suggestedTime: item.suggestedTime,
          recurring: false,
        },
      );

      return reply.code(201).send(item);
    }

    if (!body?.suggestedDate || !body?.suggestedTime) {
      return reply.code(400).send({
        error: 'Validation failed',
        fields: {
          suggestedDate: 'Data sugerida é obrigatória para recorrência',
          suggestedTime: 'Horário sugerido é obrigatório para recorrência',
        },
      });
    }

    if (!therapy.professionalDoctorId || !therapy.professional) {
      return reply.code(400).send({
        error: 'Validation failed',
        fields: {
          professionalDoctorId: 'Defina o médico da terapia no PIT para gerar recorrência automática',
        },
      });
    }

    const baseDate = new Date(body.suggestedDate);
    if (Number.isNaN(baseDate.getTime())) {
      return reply.code(400).send({
        error: 'Validation failed',
        fields: { suggestedDate: 'Data sugerida inválida' },
      });
    }

    const recurrenceWeeks = Math.max(1, Math.min(52, Number(body?.recurrenceWeeks) || 8));
    const recurringUntilDate = body?.recurringUntilDate ? new Date(body.recurringUntilDate) : null;
    const hasUntilDate = recurringUntilDate && !Number.isNaN(recurringUntilDate.getTime());
    const effectiveDuration = resolveDurationMinutes(body?.durationMinutes ?? therapy.durationMinutes);

    const createdItems: any[] = [];
    let skippedConflicts = 0;

    for (let week = 0; week < recurrenceWeeks; week += 1) {
      const candidateDate = new Date(baseDate);
      candidateDate.setHours(0, 0, 0, 0);
      candidateDate.setDate(candidateDate.getDate() + (week * 7));

      if (hasUntilDate && candidateDate > recurringUntilDate) break;

      const candidateDateIso = formatDateAsIso(candidateDate);
      const dayStart = new Date(`${candidateDateIso}T00:00:00`);
      const dayEnd = new Date(`${candidateDateIso}T23:59:59`);

      const [appointmentConflicts, preReservationConflicts] = await Promise.all([
        prisma.appointment.findMany({
          where: {
            isActive: true,
            date: candidateDateIso,
            OR: [
              { doctorName: therapy.professional },
              { patientId: therapy.pit.teaProfile.patient.id },
            ],
          },
          select: { id: true, time: true, durationMinutes: true },
        }),
        prisma.teaPreReservation.findMany({
          where: {
            status: { in: [...OPEN_STATUSES] as any },
            suggestedDate: {
              gte: dayStart,
              lte: dayEnd,
            },
            OR: [
              { professionalDoctorId: therapy.professionalDoctorId },
              { patientId: therapy.pit.teaProfile.patient.id },
            ],
          },
          select: { id: true, suggestedTime: true, durationMinutes: true },
        }),
      ]);

      const appointmentConflict = appointmentConflicts.find((item: any) => (
        item?.time && timeRangesOverlap(String(body.suggestedTime), effectiveDuration, String(item.time), item.durationMinutes)
      ));
      const preReservationConflict = preReservationConflicts.find((item: any) => (
        item?.suggestedTime && timeRangesOverlap(String(body.suggestedTime), effectiveDuration, String(item.suggestedTime), item.durationMinutes)
      ));

      if (appointmentConflict || preReservationConflict) {
        skippedConflicts += 1;
        continue;
      }

      const created = await prisma.teaPreReservation.create({
        data: {
          ...baseData,
          suggestedDate: candidateDate,
          suggestedTime: String(body.suggestedTime),
          durationMinutes: effectiveDuration,
        },
      });

      await appendTimelineEvent(
        created.id,
        'CREATED_RECURRING',
        'Pré-reserva criada por recorrência',
        actor,
        {
          status: created.status,
          suggestedDate: created.suggestedDate,
          suggestedTime: created.suggestedTime,
          recurrenceWeeks,
          weekIndex: week,
        },
      );

      createdItems.push(created);
    }

    return reply.code(201).send({
      items: createdItems,
      totalCreated: createdItems.length,
      skippedConflicts,
      recurrenceWeeks,
    });
  });

    app.post('/validate-weekly', {
      schema: {
        summary: 'Validate weekly frequency completion for selected suggestions',
        tags: ['TeaPreReservations'],
        body: {
          type: 'object',
          required: ['pitTherapyId', 'suggestions'],
          properties: {
            pitTherapyId: { type: 'string' },
            suggestions: {
              type: 'array',
              items: {
                type: 'object',
                required: ['date', 'time'],
                properties: {
                  date: { type: 'string' },
                  time: { type: 'string' },
                },
              },
            },
          },
        },
      },
    }, async (request, reply) => {
      const body = request.body as any;
      const pitTherapyId = String(body?.pitTherapyId || '');
      const suggestions = Array.isArray(body?.suggestions) ? body.suggestions : [];

      if (!pitTherapyId) {
        return reply.code(400).send({ error: 'Validation failed', fields: { pitTherapyId: 'pitTherapyId é obrigatório' } });
      }

      const therapy = await prisma.teaPitTherapy.findFirst({
      where: { id: pitTherapyId, pit: { teaProfile: { patient: { branchId: (request as any).branchId as string } } } },
        select: { id: true, weeklyFrequency: true },
      });

      if (!therapy) {
        return reply.code(404).send({ error: 'PIT therapy not found' });
      }

      const weeklyTarget = Math.max(1, Number(therapy.weeklyFrequency) || 1);
      const weekCountMap = suggestions.reduce((acc: Record<string, number>, item: any) => {
        const date = String(item?.date || '');
        const parsed = new Date(`${date}T00:00:00`);
        if (Number.isNaN(parsed.getTime())) return acc;
        const monday = startOfWeekMonday(parsed);
        const key = formatDateAsIso(monday);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});

      const weeks = Object.entries(weekCountMap).map(([weekStart, count]) => {
        const assigned = Number(count || 0);
        return {
        weekStart,
        assigned,
        target: weeklyTarget,
        missing: Math.max(0, weeklyTarget - assigned),
        exceeds: Math.max(0, assigned - weeklyTarget),
        valid: assigned === weeklyTarget,
        };
      });

      return {
        pitTherapyId,
        weeklyTarget,
        weeks,
        valid: weeks.every((item) => item.valid),
      };
    });

    app.post('/accept-group', {
      schema: {
        summary: 'Accept suggested slots in batch with optional partial selection',
        tags: ['TeaPreReservations'],
        body: {
          type: 'object',
          required: ['items'],
          properties: {
            recurring: { type: 'boolean' },
            recurrenceWeeks: { type: 'number' },
            recurringUntilDate: { type: 'string' },
            expiresAt: { type: 'string' },
            status: { type: 'string' },
            replaceExistingByTherapy: { type: 'boolean' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                required: ['pitTherapyId', 'suggestedDate', 'suggestedTime'],
                properties: {
                  pitTherapyId: { type: 'string' },
                  suggestedDate: { type: 'string' },
                  suggestedTime: { type: 'string' },
                  durationMinutes: { type: 'number' },
                  professionalDoctorId: { type: 'string' },
                  professionalName: { type: 'string' },
                },
              },
            },
          },
        },
      },
    }, async (request, reply) => {
      const body = request.body as any;
      const actor = resolveActorFromRequest(request);
      const items = Array.isArray(body?.items) ? body.items : [];

      if (items.length === 0) {
        return reply.code(400).send({ error: 'Validation failed', fields: { items: 'Informe ao menos um horário para aceitar' } });
      }

      const recurring = Boolean(body?.recurring);
      const recurrenceWeeks = Math.max(1, Math.min(52, Number(body?.recurrenceWeeks) || 8));
      const recurringUntilDate = body?.recurringUntilDate ? new Date(body.recurringUntilDate) : null;
      const hasUntilDate = Boolean(recurringUntilDate && !Number.isNaN(recurringUntilDate.getTime()));
      const expiresAt = body?.expiresAt ? new Date(body.expiresAt) : null;
      const replaceExistingByTherapy = Boolean(body?.replaceExistingByTherapy);
      const requestedStatus = normalizeStatus(body?.status);
      const acceptedStatus = requestedStatus && ['RESERVED', 'PROPOSED', 'PENDING_AUTHORIZATION', 'AUTHORIZED'].includes(requestedStatus)
        ? requestedStatus
        : 'PENDING_AUTHORIZATION';
      const shouldInferStatusFromHistory = !requestedStatus;
      const hasAuthorizedHistoryByTherapyId = new Map<string, boolean>();
      const hasPendingFrequencyIncreaseByTherapyId = new Map<string, boolean>();
      const replacedTherapyIds = new Set<string>();

      const created: any[] = [];
      let skippedConflicts = 0;

      for (const entry of items) {
        const pitTherapyId = String(entry?.pitTherapyId || '');
        const suggestedDate = String(entry?.suggestedDate || '');
        const suggestedTime = String(entry?.suggestedTime || '');
        const durationMinutes = Number.isFinite(entry?.durationMinutes) ? Math.max(0, Math.min(1440, Number(entry.durationMinutes))) : null;
        const preferredDoctorId = String(entry?.professionalDoctorId || '').trim() || null;
        const preferredDoctorName = String(entry?.professionalName || '').trim() || null;

        if (!pitTherapyId || !suggestedDate || !suggestedTime) continue;

        const therapy = await prisma.teaPitTherapy.findFirst({
      where: { id: pitTherapyId, pit: { teaProfile: { patient: { branchId: (request as any).branchId as string } } } },
          include: {
            pit: {
              include: {
                teaProfile: {
                  include: {
                    patient: { select: { id: true } },
                  },
                },
              },
            },
          },
        });

        if (!therapy || !therapy.isActive) continue;

        if (replaceExistingByTherapy && !replacedTherapyIds.has(therapy.id)) {
          const existingOpenSeries = await prisma.teaPreReservation.findMany({
            where: {
              pitId: therapy.pitId,
              pitTherapyId: therapy.id,
              status: {
                in: ['PENDING_SCHEDULING', 'RESERVED', 'PROPOSED', 'PENDING_AUTHORIZATION'] as any,
              },
            },
            select: { id: true },
          });

          if (existingOpenSeries.length > 0) {
            await prisma.teaPreReservation.updateMany({
              where: {
                id: { in: existingOpenSeries.map((row: { id: string }) => row.id) },
              },
              data: {
                status: 'CANCELED' as any,
                notes: 'Série substituída por nova proposta manual (Reservado parcial)',
              },
            });

            await Promise.all(
              existingOpenSeries.map((row: { id: string }) => appendTimelineEvent(
                row.id,
                'STATUS_CHANGED',
                'Pré-reserva substituída por nova proposta manual (Reservado parcial)',
                actor,
                {
                  status: 'CANCELED',
                  source: 'MANUAL_REPLACEMENT',
                },
              )),
            );
          }

          replacedTherapyIds.add(therapy.id);
        }

        const effectiveDuration = resolveDurationMinutes(durationMinutes ?? therapy.durationMinutes);

        let acceptedStatusForTherapy = acceptedStatus;
        if (shouldInferStatusFromHistory) {
          if (!hasPendingFrequencyIncreaseByTherapyId.has(therapy.id)) {
            const hasPendingIncrease = await hasPendingFrequencyIncreaseForTherapy(therapy.id, (request as any).branchId as string);
            hasPendingFrequencyIncreaseByTherapyId.set(therapy.id, hasPendingIncrease);
          }

          if (hasPendingFrequencyIncreaseByTherapyId.get(therapy.id)) {
            acceptedStatusForTherapy = 'PENDING_AUTHORIZATION';
          }

          if (!hasAuthorizedHistoryByTherapyId.has(therapy.id)) {
            const authorizedHistory = await prisma.teaPreReservation.findFirst({
              where: {
                pitTherapyId: therapy.id,
                status: { in: ['AUTHORIZED', 'CONVERTED'] as any },
              },
              select: { id: true },
            });
            hasAuthorizedHistoryByTherapyId.set(therapy.id, Boolean(authorizedHistory));
          }

          if (
            acceptedStatusForTherapy !== 'PENDING_AUTHORIZATION'
            && hasAuthorizedHistoryByTherapyId.get(therapy.id)
          ) {
            acceptedStatusForTherapy = 'AUTHORIZED';
          }
        }

        // Parse date-only values in local time to avoid timezone day shift.
        const baseDate = new Date(`${suggestedDate}T00:00:00`);
        if (Number.isNaN(baseDate.getTime())) continue;

        const maxIterations = recurring ? (hasUntilDate ? 120 : recurrenceWeeks) : 1;

        for (let week = 0; week < maxIterations; week += 1) {
          const candidateDate = new Date(baseDate);
          candidateDate.setDate(candidateDate.getDate() + (week * 7));

          if (hasUntilDate && recurringUntilDate && candidateDate > recurringUntilDate) {
            break;
          }

          const candidateDateIso = formatDateAsIso(candidateDate);
          const weekdayToken = JS_DAY_TO_PIT_WEEKDAY[candidateDate.getDay()];
          const dayStart = new Date(`${candidateDateIso}T00:00:00`);
          const dayEnd = new Date(`${candidateDateIso}T23:59:59`);

          const selectedDoctor = await resolveAvailableDoctorForSession({
            therapy,
            branchId: (request as any).branchId as string,
            candidateDateIso,
            suggestedTime,
            durationMinutes: effectiveDuration,
            preferredDoctorId: preferredDoctorId || therapy.professionalDoctorId || null,
          });

          if (!selectedDoctor) {
            skippedConflicts += 1;
            continue;
          }

          const createdItem = await prisma.teaPreReservation.create({
            data: {
              teaProfileId: therapy.pit.teaProfileId,
              pitId: therapy.pitId,
              pitTherapyId: therapy.id,
              patientId: therapy.pit.teaProfile.patient.id,
              procedureId: therapy.procedureId || null,
              procedureName: therapy.therapyType || null,
              professionalDoctorId: selectedDoctor.professionalDoctorId,
              professionalName: selectedDoctor.professionalName || preferredDoctorName,
              status: acceptedStatusForTherapy,
              suggestedDate: candidateDate,
              suggestedTime,
              durationMinutes: effectiveDuration,
              expiresAt,
              authorizedAt: acceptedStatusForTherapy === 'AUTHORIZED' ? new Date() : null,
            },
          });

          await appendTimelineEvent(
            createdItem.id,
            'ACCEPTED_GROUP',
            'Pré-reserva criada por aceite em lote',
            actor,
            {
              recurring,
              recurrenceWeeks: recurring ? recurrenceWeeks : 1,
              recurringUntilDate: hasUntilDate ? recurringUntilDate : null,
              status: acceptedStatusForTherapy,
              suggestedDate: createdItem.suggestedDate,
              suggestedTime: createdItem.suggestedTime,
            },
          );

          created.push(createdItem);
        }
      }

      return reply.code(201).send({
        totalCreated: created.length,
        skippedConflicts,
        items: created,
      });
    });
  app.patch('/:id/status', {
    schema: {
      summary: 'Update pre-reservation status',
      tags: ['TeaPreReservations'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      body: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string' },
          notes: { type: 'string' },
          authorizedAt: { type: 'string' },
          convertedAt: { type: 'string' },
          applySeries: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;
    const actor = resolveActorFromRequest(request);

    const status = normalizeStatus(body?.status);
    if (!status) {
      return reply.code(400).send({ error: 'Validation failed', fields: { status: 'Status inválido' } });
    }

    const existing = await prisma.teaPreReservation.findFirst({ where: { id, patient: { branchId: (request as any).branchId as string } } });
    if (!existing) return reply.code(404).send({ error: 'Pre-reservation not found' });

    const hasPendingFrequencyIncrease = status === 'PENDING_AUTHORIZATION'
      ? await hasPendingFrequencyIncreaseForTherapy(existing.pitTherapyId, (request as any).branchId as string)
      : false;
    const shouldBypassAuthorizationStep = status === 'PENDING_AUTHORIZATION' && !hasPendingFrequencyIncrease
      ? Boolean(await prisma.teaPreReservation.findFirst({
        where: {
          pitTherapyId: existing.pitTherapyId,
          status: { in: ['AUTHORIZED', 'CONVERTED'] as any },
        },
        select: { id: true },
      }))
      : false;
    const resolvedStatus = shouldBypassAuthorizationStep ? 'AUTHORIZED' : status;

    const applySeries = Boolean(body?.applySeries);

    if (applySeries) {
      const targets = await prisma.teaPreReservation.findMany({
        where: {
          pitId: existing.pitId,
          pitTherapyId: existing.pitTherapyId,
          status: {
            in: ['PENDING_SCHEDULING', 'PROPOSED', 'RESERVED', 'PENDING_AUTHORIZATION', 'AUTHORIZED'] as any,
          },
        },
        orderBy: { createdAt: 'asc' },
      });

      const updatedItems: any[] = [];

      for (const target of targets) {
        const statusIsProposed = resolvedStatus === 'PROPOSED';
        const expiresAtValue = body?.expiresAt
          ? new Date(body.expiresAt)
          : (statusIsProposed ? new Date(Date.now() + (48 * 60 * 60 * 1000)) : undefined);
        const updated = await prisma.teaPreReservation.update({
          where: { id: target.id },
          data: {
            status: resolvedStatus,
            notes: body?.notes !== undefined ? (body.notes || null) : undefined,
            expiresAt: expiresAtValue,
            authorizedAt: body?.authorizedAt ? new Date(body.authorizedAt) : (resolvedStatus === 'AUTHORIZED' ? new Date() : undefined),
            convertedAt: body?.convertedAt ? new Date(body.convertedAt) : (resolvedStatus === 'CONVERTED' ? new Date() : undefined),
          },
        });

        await appendTimelineEvent(
          updated.id,
          'STATUS_CHANGED',
          `Status alterado para ${resolvedStatus}`,
          actor,
          {
            previousStatus: target.status,
            requestedStatus: status,
            nextStatus: resolvedStatus,
            applySeries: true,
            bypassedAuthorizationStep: shouldBypassAuthorizationStep,
          },
        );

        updatedItems.push(updated);
      }

      return {
        updatedCount: updatedItems.length,
        items: updatedItems,
      };
    }

    const updated = await prisma.teaPreReservation.update({
      where: { id },
      data: {
        status: resolvedStatus,
        notes: body?.notes !== undefined ? (body.notes || null) : undefined,
        expiresAt: body?.expiresAt
          ? new Date(body.expiresAt)
          : (resolvedStatus === 'PROPOSED' ? new Date(Date.now() + (48 * 60 * 60 * 1000)) : undefined),
        authorizedAt: body?.authorizedAt ? new Date(body.authorizedAt) : (resolvedStatus === 'AUTHORIZED' ? new Date() : undefined),
        convertedAt: body?.convertedAt ? new Date(body.convertedAt) : (resolvedStatus === 'CONVERTED' ? new Date() : undefined),
      },
    });

    await appendTimelineEvent(
      updated.id,
      'STATUS_CHANGED',
      `Status alterado para ${resolvedStatus}`,
      actor,
      {
        previousStatus: existing.status,
        requestedStatus: status,
        nextStatus: resolvedStatus,
        bypassedAuthorizationStep: shouldBypassAuthorizationStep,
      },
    );

    return updated;
  });

  app.get('/cancellation-therapies', {
    schema: {
      summary: 'List TEA therapy series available for batch cancellation',
      tags: ['TeaPreReservations'],
      querystring: {
        type: 'object',
        required: ['teaProfileId'],
        properties: {
          teaProfileId: { type: 'string' },
          fromDate: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { teaProfileId, fromDate } = request.query as { teaProfileId?: string; fromDate?: string };
    if (!teaProfileId) {
      return reply.code(400).send({ error: 'Validation failed', fields: { teaProfileId: 'teaProfileId é obrigatório' } });
    }

    const fromIso = String(fromDate || formatDateAsIso(new Date()));
    const fromDateStart = new Date(`${fromIso}T00:00:00`);
    if (Number.isNaN(fromDateStart.getTime())) {
      return reply.code(400).send({ error: 'Validation failed', fields: { fromDate: 'Data inválida' } });
    }

    const convertedReservations = await prisma.teaPreReservation.findMany({
      where: {
        teaProfileId: String(teaProfileId),
        status: 'CONVERTED' as any,
        suggestedTime: { not: null },
      },
      include: {
        pitTherapy: {
          select: {
            id: true,
            isActive: true,
            therapyType: true,
            professional: true,
            procedureId: true,
            professionalDoctorId: true,
            pitId: true,
            weeklyFrequency: true,
            preferredWeekdays: true,
            preferredShift: true,
          },
        },
      },
      orderBy: [{ suggestedDate: 'asc' }, { suggestedTime: 'asc' }],
    });

    if (convertedReservations.length === 0) {
      return { items: [], total: 0 };
    }

    const patientId = convertedReservations.find((item: any) => String(item?.patientId || '').trim())?.patientId;
    if (!patientId) {
      return { items: [], total: 0 };
    }

    const appointments = await prisma.appointment.findMany({
      where: {
        isActive: true,
        patientId: String(patientId),
        type: 'RETORNO TEA',
        date: { gte: fromIso },
        NOT: [
          { status: 'CANCELED' },
          { status: 'CANCELADO' },
          { status: 'COMPLETED' },
          { status: 'CONCLUIDO' },
        ],
      },
      select: {
        id: true,
        date: true,
        time: true,
      },
    });

    const activeAppointmentSignatures = new Set(
      appointments
        .filter((it: any) => it?.date && it?.time)
        .map((it: any) => `${String(it.date)}#${String(it.time)}`),
    );

    const grouped = new Map<string, any>();

    convertedReservations.forEach((reservation: any) => {
      if (!reservation?.pitTherapy?.isActive) return;

      const dateIso = reservation?.suggestedDate ? formatDateAsIso(new Date(reservation.suggestedDate)) : null;
      const time = reservation?.suggestedTime ? String(reservation.suggestedTime) : null;
      if (!dateIso || !time) return;

      const signature = `${dateIso}#${time}`;
      if (!activeAppointmentSignatures.has(signature)) return;

      const pitTherapyId = String(reservation?.pitTherapyId || '');
      if (!pitTherapyId) return;

      if (!grouped.has(pitTherapyId)) {
        grouped.set(pitTherapyId, {
          pitTherapyId,
          procedureName: reservation?.procedureName || reservation?.pitTherapy?.therapyType || 'Procedimento não definido',
          professionalName: reservation?.professionalName || reservation?.pitTherapy?.professional || 'Profissional não definido',
          weeklyFrequency: Number(reservation?.pitTherapy?.weeklyFrequency || 1) || 1,
          preferredWeekdays: Array.isArray(reservation?.pitTherapy?.preferredWeekdays) ? reservation.pitTherapy.preferredWeekdays : [],
          preferredShift: reservation?.pitTherapy?.preferredShift || null,
          totalSessions: 0,
          slots: [] as Array<{ date: string; time: string }>,
        });
      }

      const item = grouped.get(pitTherapyId);
      const alreadyAdded = item.slots.some((slot: any) => slot.date === dateIso && slot.time === time);
      if (!alreadyAdded) {
        item.slots.push({ date: dateIso, time });
        item.totalSessions += 1;
      }
    });

    const items = Array.from(grouped.values()).map((item: any) => ({
      ...item,
      slots: item.slots.sort((a: any, b: any) => {
        const dateDiff = new Date(`${a.date}T00:00:00`).getTime() - new Date(`${b.date}T00:00:00`).getTime();
        if (dateDiff !== 0) return dateDiff;
        return parseTimeToSortableValue(a.time) - parseTimeToSortableValue(b.time);
      }),
    }));

    return {
      items,
      total: items.length,
    };
  });

  app.post('/cancel-therapy-series', {
    schema: {
      summary: 'Cancel all future appointments for a TEA therapy series',
      tags: ['TeaPreReservations'],
      body: {
        type: 'object',
        required: ['teaProfileId'],
        properties: {
          teaProfileId: { type: 'string' },
          pitTherapyId: { type: 'string' },
          cancelAll: { type: 'boolean' },
          fromDate: { type: 'string' },
          weekdayIndex: { type: 'number' },
          reason: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { teaProfileId?: string; pitTherapyId?: string; cancelAll?: boolean; fromDate?: string; weekdayIndex?: number; reason?: string };
    const actor = resolveActorFromRequest(request);
    const cancelAll = Boolean(body?.cancelAll);
    const hasWeekdayFilter = Number.isInteger(body?.weekdayIndex);
    const weekdayIndex = hasWeekdayFilter ? Number(body?.weekdayIndex) : null;

    if (!body?.teaProfileId || (!cancelAll && !body?.pitTherapyId)) {
      return reply.code(400).send({
        error: 'Validation failed',
        fields: {
          teaProfileId: !body?.teaProfileId ? 'teaProfileId é obrigatório' : undefined,
          pitTherapyId: (!cancelAll && !body?.pitTherapyId) ? 'pitTherapyId é obrigatório' : undefined,
        },
      });
    }

    if (hasWeekdayFilter && (weekdayIndex === null || weekdayIndex < 0 || weekdayIndex > 6)) {
      return reply.code(400).send({
        error: 'Validation failed',
        fields: {
          weekdayIndex: 'weekdayIndex deve ser um número entre 0 e 6',
        },
      });
    }

    const fromIso = String(body?.fromDate || formatDateAsIso(new Date()));
    const fromDateStart = new Date(`${fromIso}T00:00:00`);
    if (Number.isNaN(fromDateStart.getTime())) {
      return reply.code(400).send({ error: 'Validation failed', fields: { fromDate: 'Data inválida' } });
    }

    const candidateReservations = await prisma.teaPreReservation.findMany({
      where: {
        teaProfileId: String(body.teaProfileId),
        ...(cancelAll ? {} : { pitTherapyId: String(body.pitTherapyId) }),
        status: 'CONVERTED' as any,
        suggestedDate: { gte: fromDateStart },
        suggestedTime: { not: null },
      },
      select: {
        id: true,
        patientId: true,
        pitTherapyId: true,
        suggestedDate: true,
        suggestedTime: true,
      },
      orderBy: [{ suggestedDate: 'asc' }, { suggestedTime: 'asc' }],
    });

    const reservations = hasWeekdayFilter
      ? candidateReservations.filter((reservation: any) => {
        const dateIso = reservation?.suggestedDate ? formatDateAsIso(new Date(reservation.suggestedDate)) : null;
        if (!dateIso) return false;
        return new Date(`${dateIso}T00:00:00`).getDay() === weekdayIndex;
      })
      : candidateReservations;

    if (reservations.length === 0) {
      return {
        canceledAppointments: 0,
        affectedReservations: 0,
      };
    }

    const patientId = reservations[0]?.patientId;
    if (!patientId) {
      return {
        canceledAppointments: 0,
        affectedReservations: 0,
      };
    }

    let canceledAppointments = 0;
    const targetPitTherapyIds = Array.from(
      new Set(
        reservations
          .map((reservation: any) => String(reservation?.pitTherapyId || ''))
          .filter(Boolean),
      ),
    );
    const slotSignatures = new Set<string>();
    reservations.forEach((reservation: any) => {
      const dateIso = reservation?.suggestedDate ? formatDateAsIso(new Date(reservation.suggestedDate)) : null;
      const time = reservation?.suggestedTime ? String(reservation.suggestedTime) : null;
      if (!dateIso || !time) return;
      slotSignatures.add(`${dateIso}#${time}`);
    });

    await prisma.$transaction(async (tx: any) => {
      for (const signature of slotSignatures) {
        const [dateIso, time] = signature.split('#');
        if (!dateIso || !time) continue;

        const updateResult = await tx.appointment.updateMany({
          where: {
            isActive: true,
            patientId: String(patientId),
            type: 'RETORNO TEA',
            date: dateIso,
            time,
            NOT: [
              { status: 'CANCELED' },
              { status: 'CANCELADO' },
              { status: 'COMPLETED' },
              { status: 'CONCLUIDO' },
            ],
          },
          data: {
            status: 'CANCELED',
            isActive: false,
            observations: body?.reason
              ? `Cancelamento em lote TEA: ${String(body.reason)}`
              : 'Cancelamento em lote TEA',
          },
        });

        canceledAppointments += Number(updateResult?.count || 0);
      }

      await tx.teaPreReservationTimeline.createMany({
        data: reservations.map((reservation: any) => ({
          preReservationId: reservation.id,
          eventType: hasWeekdayFilter
            ? 'APPOINTMENT_CANCELED_BATCH_WEEKDAY'
            : (cancelAll ? 'APPOINTMENT_CANCELED_BATCH_ALL' : 'APPOINTMENT_CANCELED_BATCH'),
          eventLabel: hasWeekdayFilter
            ? 'Agendamento cancelado em lote por dia da semana'
            : (cancelAll ? 'Agendamento cancelado em lote (todas as terapias)' : 'Agendamento cancelado em lote'),
          actor,
          payload: {
            reason: body?.reason || null,
            fromDate: fromIso,
            cancelAll,
            weekdayIndex,
          },
        })),
      });

      // Remove canceled therapies from active PIT flow so they do not return to pre-reservation.
      if (!hasWeekdayFilter && targetPitTherapyIds.length > 0) {
        await tx.teaPitTherapy.updateMany({
          where: {
            id: { in: targetPitTherapyIds },
            pit: {
              teaProfileId: String(body.teaProfileId),
            },
          },
          data: {
            isActive: false,
          },
        });

        await tx.teaPreReservation.updateMany({
          where: {
            teaProfileId: String(body.teaProfileId),
            pitTherapyId: { in: targetPitTherapyIds },
            status: {
              in: ['PENDING_SCHEDULING', 'RESERVED', 'PROPOSED', 'PENDING_AUTHORIZATION', 'AUTHORIZED'] as any,
            },
          },
          data: {
            status: 'CANCELED' as any,
            notes: body?.reason
              ? `Terapia removida do PIT por desmarcação em lote: ${String(body.reason)}`
              : 'Terapia removida do PIT por desmarcação em lote',
          },
        });
      }
    });

    return {
      canceledAppointments,
      affectedReservations: reservations.length,
      deactivatedTherapies: hasWeekdayFilter ? 0 : targetPitTherapyIds.length,
    };
  });

  app.get('/:id/conversion-checklist', {
    schema: {
      summary: 'Get pre-conversion checklist for a pre-reservation',
      tags: ['TeaPreReservations'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const preReservation = await prisma.teaPreReservation.findFirst({
      where: {
        id,
        patient: { branchId: (request as any).branchId as string },
      },
      include: {
        patient: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!preReservation) {
      return reply.code(404).send({ error: 'Pre-reservation not found' });
    }

    const hasDateTime = Boolean(preReservation.suggestedDate && preReservation.suggestedTime);
    const isConvertibleStatus = ['AUTHORIZED', 'RESERVED', 'PENDING_AUTHORIZATION'].includes(String(preReservation.status || ''));
    const isAlreadyConverted = preReservation.status === 'CONVERTED';
    const isExpired = Boolean(preReservation.expiresAt && preReservation.expiresAt.getTime() < Date.now());

    const appointmentDate = preReservation.suggestedDate
      ? formatDateAsIso(new Date(preReservation.suggestedDate))
      : null;

    let hasDoctorConflict = false;
    let hasPatientConflict = false;

    if (appointmentDate && preReservation.suggestedTime) {
      const [doctorConflict, patientConflict] = await Promise.all([
        prisma.appointment.findFirst({
          where: {
            isActive: true,
            date: appointmentDate,
            time: preReservation.suggestedTime,
            doctorName: preReservation.professionalName || undefined,
          },
          select: { id: true },
        }),
        prisma.appointment.findFirst({
          where: {
            isActive: true,
            date: appointmentDate,
            time: preReservation.suggestedTime,
            patientId: preReservation.patient.id,
          },
          select: { id: true },
        }),
      ]);

      hasDoctorConflict = Boolean(doctorConflict);
      hasPatientConflict = Boolean(patientConflict);
    }

    const checks = [
      {
        key: 'status-authorized',
        label: 'Status apto para conversão',
        valid: isConvertibleStatus,
        message: isConvertibleStatus ? 'OK' : 'Status precisa estar em AUTHORIZED, RESERVED ou PENDING_AUTHORIZATION',
      },
      {
        key: 'date-time-defined',
        label: 'Data e horário definidos',
        valid: hasDateTime,
        message: hasDateTime ? 'OK' : 'Defina data e horário sugeridos',
      },
      {
        key: 'not-expired',
        label: 'Não expirado',
        valid: !isExpired,
        message: !isExpired ? 'OK' : 'Pré-reserva expirada',
      },
      {
        key: 'doctor-conflict',
        label: 'Sem conflito de médico',
        valid: !hasDoctorConflict,
        message: !hasDoctorConflict ? 'OK' : 'Existe agendamento do médico no mesmo horário',
      },
      {
        key: 'patient-conflict',
        label: 'Sem conflito de paciente',
        valid: !hasPatientConflict,
        message: !hasPatientConflict ? 'OK' : 'Existe agendamento do paciente no mesmo horário',
      },
      {
        key: 'not-converted',
        label: 'Ainda não convertido',
        valid: !isAlreadyConverted,
        message: !isAlreadyConverted ? 'OK' : 'Pré-reserva já convertida',
      },
    ];

    return {
      preReservationId: preReservation.id,
      canConvert: checks.every((item) => item.valid),
      checks,
    };
  });

  app.get('/:id/timeline', {
    schema: {
      summary: 'Get timeline events for a pre-reservation',
      tags: ['TeaPreReservations'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const preReservation = await prisma.teaPreReservation.findFirst({
      where: { id, patient: { branchId: (request as any).branchId as string } },
      select: { id: true },
    });
    if (!preReservation) {
      return reply.code(404).send({ error: 'Pre-reservation not found' });
    }

    const events = await prisma.teaPreReservationTimeline.findMany({
      where: { preReservationId: id },
      orderBy: { createdAt: 'asc' },
    });

    return {
      preReservationId: id,
      events,
    };
  });

  app.post('/:id/convert-to-appointment', {
    schema: {
      summary: 'Convert authorized pre-reservation into appointment',
      tags: ['TeaPreReservations'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      body: {
        type: 'object',
        properties: {
          overrideStatus: { type: 'string' },
          observation: { type: 'string' },
          convertSeries: { type: 'boolean' },
          seriesStartDate: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      overrideStatus?: string;
      observation?: string;
      convertSeries?: boolean;
      seriesStartDate?: string;
    };
    const actor = resolveActorFromRequest(request);
    const branchId = (request as any).branchId as string;

    const preReservation = await prisma.teaPreReservation.findFirst({
      where: {
        id,
        patient: { branchId: (request as any).branchId as string },
      },
      include: {
        patient: {
          select: {
            id: true,
            name: true,
            cpf: true,
            healthInsuranceName: true,
          },
        },
      },
    });

    if (!preReservation) return reply.code(404).send({ error: 'Pre-reservation not found' });

    if (preReservation.status === 'CONVERTED') {
      return reply.code(400).send({ error: 'Pre-reservation already converted' });
    }

    const convertSeries = Boolean(body?.convertSeries);

    if (convertSeries) {
      const convertibleSeriesStatuses = ['AUTHORIZED', 'RESERVED', 'PENDING_AUTHORIZATION'] as const;
      const seriesReservations = await prisma.teaPreReservation.findMany({
        where: {
          pitId: preReservation.pitId,
          pitTherapyId: preReservation.pitTherapyId,
          status: { in: [...convertibleSeriesStatuses] as any },
        },
        include: {
          patient: {
            select: {
              id: true,
              name: true,
              cpf: true,
              healthInsuranceName: true,
            },
          },
        },
        orderBy: [{ suggestedDate: 'asc' }, { suggestedTime: 'asc' }],
      });

      if (seriesReservations.length === 0) {
        return reply.code(400).send({
          error: 'No convertible pre-reservations found for this therapy',
        });
      }

      const appointmentStatus = body?.overrideStatus || 'AGENDADO';
      const therapy = await prisma.teaPitTherapy.findFirst({
        where: { id: preReservation.pitTherapyId || undefined },
        select: { preferredWeekdays: true },
      });

      const seriesStartDateRaw = String(body?.seriesStartDate || '').trim();
      const parsedSeriesStartDate = seriesStartDateRaw ? new Date(`${seriesStartDateRaw}T00:00:00`) : null;
      const hasValidSeriesStartDate = Boolean(
        parsedSeriesStartDate && !Number.isNaN(parsedSeriesStartDate.getTime()),
      );
      const converted: any[] = [];
      let skippedConflicts = 0;
      let skippedInvalid = 0;
      let mergedChunks = 0;

      const reservationsToConvert: any[] = [];
      const reservationsMergedIntoAnchor: Array<{ reservation: any; anchor: any }> = [];
      let lastAnchorByDay: Record<string, any> = {};

      for (const reservation of seriesReservations) {
        if (!reservation.suggestedDate || !reservation.suggestedTime) {
          skippedInvalid += 1;
          continue;
        }

        if (reservation.expiresAt && reservation.expiresAt.getTime() < Date.now()) {
          skippedInvalid += 1;
          continue;
        }

        const reservationDateIso = formatDateAsIso(new Date(reservation.suggestedDate));
        const previousAnchor = lastAnchorByDay[reservationDateIso] || null;

        if (previousAnchor?.suggestedTime) {
          const previousStart = timeToMinutes(String(previousAnchor.suggestedTime));
          const currentStart = timeToMinutes(String(reservation.suggestedTime));
          const anchorDuration = Math.max(15, Number(previousAnchor.durationMinutes) || 15);
          const insideAnchorWindow = currentStart > previousStart && currentStart < (previousStart + anchorDuration);

          // Guardrail: if the series was mistakenly persisted as 15-min chunks for one session,
          // merge those chunks into the first slot instead of creating multiple appointments.
          if (insideAnchorWindow) {
            reservationsMergedIntoAnchor.push({ reservation, anchor: previousAnchor });
            mergedChunks += 1;
            continue;
          }
        }

        reservationsToConvert.push(reservation);
        lastAnchorByDay[reservationDateIso] = reservation;
      }

      const overrideSeriesDates = hasValidSeriesStartDate
        ? buildSeriesDatesFromWeekdays(
            formatDateAsIso(parsedSeriesStartDate as Date),
            Array.isArray(therapy?.preferredWeekdays) ? (therapy.preferredWeekdays as string[]) : [],
            reservationsToConvert.length,
          )
        : [];

      for (const [reservationIndex, reservation] of reservationsToConvert.entries()) {
        const fallbackDate = formatDateAsIso(new Date(reservation.suggestedDate));
        const appointmentDate = overrideSeriesDates[reservationIndex] || fallbackDate;

        const [doctorConflicts, patientConflicts] = await Promise.all([
          prisma.appointment.findMany({
            where: {
              isActive: true,
              date: appointmentDate,
              doctorName: reservation.professionalName || undefined,
            },
            select: { id: true, time: true, durationMinutes: true },
          }),
          prisma.appointment.findMany({
            where: {
              isActive: true,
              date: appointmentDate,
              patientId: reservation.patient.id,
            },
            select: { id: true, time: true, durationMinutes: true },
          }),
        ]);

        const doctorConflict = doctorConflicts.find((item: any) => (
          item?.time && timeRangesOverlap(String(reservation.suggestedTime), reservation.durationMinutes, String(item.time), item.durationMinutes)
        ));
        const patientConflict = patientConflicts.find((item: any) => (
          item?.time && timeRangesOverlap(String(reservation.suggestedTime), reservation.durationMinutes, String(item.time), item.durationMinutes)
        ));

        if (doctorConflict || patientConflict) {
          if (patientConflict) {
            const updatedPreReservation = await prisma.teaPreReservation.update({
              where: { id: reservation.id },
              data: {
                status: 'CONVERTED',
                convertedAt: new Date(),
                suggestedDate: new Date(`${appointmentDate}T12:00:00`),
              },
            });

            await appendTimelineEvent(
              updatedPreReservation.id,
              'CONVERTED_ALREADY_SCHEDULED',
              'Pré-reserva marcada como convertida (sessão já existente)',
              actor,
              {
                existingAppointmentId: patientConflict.id,
                convertSeries: true,
              },
            );

            converted.push({
              appointment: null,
              preReservation: updatedPreReservation,
              reusedExistingAppointment: true,
            });
            continue;
          }

          skippedConflicts += 1;
          continue;
        }

        const result = await prisma.$transaction(async (tx: any) => {
          const appointment = await tx.appointment.create({
            data: {
              branchId,
              patientId: reservation.patient.id,
              patientName: reservation.patient.name || null,
              patientCpf: reservation.patient.cpf || null,
              doctorName: reservation.professionalName || null,
              specialty: reservation.procedureName || null,
              convenio: reservation.patient.healthInsuranceName || null,
              date: appointmentDate,
              time: reservation.suggestedTime,
              durationMinutes: reservation.durationMinutes || null,
              type: 'RETORNO TEA',
              status: appointmentStatus,
              observations: body?.observation || `Agendamento convertido da pré-reserva TEA ${reservation.id}`,
            },
          });

          const updatedPreReservation = await tx.teaPreReservation.update({
            where: { id: reservation.id },
            data: {
              status: 'CONVERTED',
              convertedAt: new Date(),
              suggestedDate: new Date(`${appointmentDate}T12:00:00`),
            },
          });

          return { appointment, preReservation: updatedPreReservation };
        });

        await appendTimelineEvent(
          result.preReservation.id,
          'CONVERTED',
          'Pré-reserva convertida em agendamento',
          actor,
          {
            appointmentId: result.appointment.id,
            appointmentStatus,
            convertSeries: true,
          },
        );

        converted.push(result);
      }

      if (reservationsMergedIntoAnchor.length > 0) {
        const mergedIds = reservationsMergedIntoAnchor.map((item) => item.reservation.id);
        await prisma.teaPreReservation.updateMany({
          where: {
            id: { in: mergedIds },
            status: { in: [...convertibleSeriesStatuses] as any },
          },
          data: {
            status: 'CONVERTED',
            convertedAt: new Date(),
          },
        });

        await Promise.all(reservationsMergedIntoAnchor.map((item) => (
          appendTimelineEvent(
            item.reservation.id,
            'CONVERTED_CHUNK_MERGED',
            'Pré-reserva consolidada em sessão já convertida',
            actor,
            {
              mergedIntoPreReservationId: item.anchor.id,
              mergedIntoSuggestedDate: item.anchor.suggestedDate,
              mergedIntoSuggestedTime: item.anchor.suggestedTime,
            },
          )
        )));
      }

      return {
        convertedCount: converted.length,
        skippedConflicts,
        skippedInvalid,
        mergedChunks,
        items: converted,
      };
    }

    if (preReservation.status !== 'AUTHORIZED') {
      return reply.code(400).send({
        error: 'Pre-reservation must be AUTHORIZED before conversion',
        fields: { status: 'Status atual deve ser AUTHORIZED para converter' },
      });
    }

    if (!preReservation.suggestedDate || !preReservation.suggestedTime) {
      return reply.code(400).send({
        error: 'Pre-reservation requires suggested date/time to convert',
        fields: {
          suggestedDate: 'Data sugerida é obrigatória',
          suggestedTime: 'Horário sugerido é obrigatório',
        },
      });
    }

    if (preReservation.expiresAt && preReservation.expiresAt.getTime() < Date.now()) {
      return reply.code(400).send({
        error: 'Pre-reservation expired and cannot be converted',
        fields: { expiresAt: 'Pré-reserva expirada. Renove antes de converter.' },
      });
    }

    const appointmentDate = formatDateAsIso(new Date(preReservation.suggestedDate));
    const [doctorConflicts, patientConflicts] = await Promise.all([
      prisma.appointment.findMany({
        where: {
          isActive: true,
          date: appointmentDate,
          doctorName: preReservation.professionalName || undefined,
        },
        select: { id: true, time: true, durationMinutes: true },
      }),
      prisma.appointment.findMany({
        where: {
          isActive: true,
          date: appointmentDate,
          patientId: preReservation.patient.id,
        },
        select: { id: true, time: true, durationMinutes: true },
      }),
    ]);

    const doctorConflict = doctorConflicts.find((item: any) => (
      item?.time && timeRangesOverlap(String(preReservation.suggestedTime), preReservation.durationMinutes, String(item.time), item.durationMinutes)
    ));
    const patientConflict = patientConflicts.find((item: any) => (
      item?.time && timeRangesOverlap(String(preReservation.suggestedTime), preReservation.durationMinutes, String(item.time), item.durationMinutes)
    ));

    if (doctorConflict || patientConflict) {
      return reply.code(409).send({
        error: 'Conflict detected for doctor or patient at conversion time',
      });
    }

    const appointmentStatus = body?.overrideStatus || 'AGENDADO';

    const result = await prisma.$transaction(async (tx: any) => {
      const appointment = await tx.appointment.create({
        data: {
          branchId,
          patientId: preReservation.patient.id,
          patientName: preReservation.patient.name || null,
          patientCpf: preReservation.patient.cpf || null,
          doctorName: preReservation.professionalName || null,
          specialty: preReservation.procedureName || null,
          convenio: preReservation.patient.healthInsuranceName || null,
          date: appointmentDate,
          time: preReservation.suggestedTime,
          durationMinutes: preReservation.durationMinutes || null,
          type: 'RETORNO TEA',
          status: appointmentStatus,
          observations: body?.observation || `Agendamento convertido da pré-reserva TEA ${preReservation.id}`,
        },
      });

      const updatedPreReservation = await tx.teaPreReservation.update({
        where: { id: preReservation.id },
        data: {
          status: 'CONVERTED',
          convertedAt: new Date(),
        },
      });

      return { appointment, preReservation: updatedPreReservation };
    });

    await appendTimelineEvent(
      result.preReservation.id,
      'CONVERTED',
      'Pré-reserva convertida em agendamento',
      actor,
      {
        appointmentId: result.appointment.id,
        appointmentStatus,
      },
    );

    return result;
  });

  app.get('/', {
    schema: {
      summary: 'List created pre-reservations',
      tags: ['TeaPreReservations'],
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          limit: { type: 'number', default: 100 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request) => {
    await expireOverdueReservations();

    const { status, limit = 100, offset = 0 } = request.query as { status?: string; limit?: number; offset?: number };
    const normalizedStatus = normalizeStatus(status);

    const where: any = {};
    if (normalizedStatus) where.status = normalizedStatus;

    const [items, total] = await Promise.all([
      prisma.teaPreReservation.findMany({
        where,
        include: {
          patient: { select: { id: true, name: true, cpf: true, birthDate: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.teaPreReservation.count({ where }),
    ]);

    const pitTherapyIds = Array.from(new Set(items.map((item: any) => String(item?.pitTherapyId || '')).filter(Boolean)));
    const attachments = pitTherapyIds.length > 0
      ? await prisma.convenioAuthorizationAttachment.findMany({
        where: {
          branchId: (request as any).branchId as string,
          isActive: true,
          sourceType: 'TEA',
          pitTherapyId: { in: pitTherapyIds },
        },
        orderBy: { uploadedAt: 'desc' },
      })
      : [];

    const attachmentsByTherapyId = new Map<string, any[]>();
    attachments.forEach((item: any) => {
      const key = String(item?.pitTherapyId || '');
      if (!key) return;
      if (!attachmentsByTherapyId.has(key)) attachmentsByTherapyId.set(key, []);
      attachmentsByTherapyId.get(key)!.push(item);
    });

    const itemsWithAttachments = items.map((item: any) => {
      const docs = attachmentsByTherapyId.get(String(item?.pitTherapyId || '')) || [];
      return {
        ...item,
        authorizationAttachmentsCount: docs.length,
        authorizationAttachments: docs.slice(0, 5).map((doc: any) => ({
          id: doc.id,
          fileName: doc.fileName,
          uploadedAt: doc.uploadedAt,
        })),
      };
    });

    return { items: itemsWithAttachments, total };
  });
}
