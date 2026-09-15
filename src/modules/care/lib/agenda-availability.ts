export type AgendaAvailabilityInput = {
  branchId: string;
  agendaId?: string | null;
  doctorId?: string | null;
  doctorName?: string | null;
  procedureId?: string | null;
  procedureName?: string | null;
  specialty?: string | null;
  roomId?: string | null;
  date: string;
  time: string;
  durationMinutes?: number | null;
  /** Used only by flows that intentionally create a generic follow-up. */
  allowUnscopedSpecialty?: boolean;
};

export type AgendaAvailabilityResult = {
  agendaId: string;
  branchId: string;
  doctorId: string;
  doctorName: string;
  roomId: string | null;
  roomName: string | null;
  weekday: string;
  shiftStart: string;
  shiftEnd: string;
  specialtyIds: string[];
  procedureIds: string[];
};

export type AgendaAvailabilitySlot = AgendaAvailabilityResult & {
  date: string;
  time: string;
};

export type AgendaAvailabilityErrorCode =
  | 'INVALID_DATE'
  | 'INVALID_TIME'
  | 'PROFESSIONAL_NOT_FOUND'
  | 'PROCEDURE_NOT_FOUND'
  | 'AGENDA_NOT_FOUND'
  | 'AGENDA_DATE_UNAVAILABLE'
  | 'AGENDA_TIME_UNAVAILABLE'
  | 'AGENDA_SPECIALTY_MISMATCH'
  | 'AGENDA_ROOM_MISMATCH';

export class AgendaAvailabilityError extends Error {
  readonly code: AgendaAvailabilityErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: AgendaAvailabilityErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AgendaAvailabilityError';
    this.code = code;
    this.details = details;
  }
}

const WEEKDAY_BY_DAY: Record<number, string> = {
  0: 'domingo',
  1: 'segunda',
  2: 'terca',
  3: 'quarta',
  4: 'quinta',
  5: 'sexta',
  6: 'sabado',
};

const normalizeText = (value: unknown) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

export const normalizeAgendaWeekday = (value: unknown) => normalizeText(value);

const normalizeTime = (value: unknown): string | null => {
  const raw = String(value || '').trim();
  if (!/^\d{2}:\d{2}$/.test(raw)) return null;
  const [hours, minutes] = raw.split(':').map(Number);
  if (hours > 23 || minutes > 59) return null;
  return raw;
};

const timeToMinutes = (value: string) => {
  const [hours, minutes] = value.split(':').map(Number);
  return (hours * 60) + minutes;
};

const normalizeDate = (value: unknown): string | null => {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) return null;
  return raw;
};

const dateKey = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
};

const dateIsWithinAgendaRange = (date: string, startDate?: Date | string | null, endDate?: Date | string | null) => {
  const start = dateKey(startDate);
  const end = dateKey(endDate);
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
};

const getAgendaSpecialtyIds = (agenda: any): string[] => Array.from(new Set([
  ...(Array.isArray(agenda?.especialidadeIds) ? agenda.especialidadeIds : []),
  agenda?.especialidadeId,
].map((value) => String(value || '').trim()).filter(Boolean)));

const splitSpecialtyNames = (value?: string | null): string[] => Array.from(new Set(
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
));

const branchScope = (branchId: string) => ({
  OR: [
    { branchId },
    { branchIds: { has: branchId } },
  ],
});

async function resolveDoctor(db: any, input: AgendaAvailabilityInput) {
  const doctorId = String(input.doctorId || '').trim();
  const doctorName = String(input.doctorName || '').trim();
  if (!doctorId && !doctorName) {
    throw new AgendaAvailabilityError(
      'PROFESSIONAL_NOT_FOUND',
      'Selecione um profissional para verificar a agenda.',
    );
  }

  const doctor = await db.doctor.findFirst({
    where: {
      ...branchScope(input.branchId),
      isActive: true,
      ...(doctorId
        ? { id: doctorId }
        : { name: { equals: doctorName, mode: 'insensitive' } }),
    },
    select: { id: true, name: true },
  });

  if (!doctor) {
    throw new AgendaAvailabilityError(
      'PROFESSIONAL_NOT_FOUND',
      'O profissional selecionado não está ativo ou não atende nessa unidade.',
      { doctorId: doctorId || null, doctorName: doctorName || null },
    );
  }

  return doctor;
}

async function resolveProcedureSpecialties(db: any, input: AgendaAvailabilityInput) {
  const procedureId = String(input.procedureId || '').trim();
  const procedureNames = splitSpecialtyNames(input.procedureName || input.specialty);
  const procedures = procedureId
    ? await db.procedure.findMany({
      where: { ...branchScope(input.branchId), isActive: true, id: procedureId },
      select: { id: true, name: true, especialidadeId: true },
    })
    : procedureNames.length > 0
      ? await db.procedure.findMany({
        where: {
          ...branchScope(input.branchId),
          isActive: true,
          OR: procedureNames.map((name) => ({ name: { equals: name, mode: 'insensitive' as const } })),
        },
        select: { id: true, name: true, especialidadeId: true },
      })
      : [];

  if (procedureId && procedures.length === 0) {
    throw new AgendaAvailabilityError(
      'PROCEDURE_NOT_FOUND',
      'O procedimento selecionado não está ativo ou não pertence a essa unidade.',
      { procedureId },
    );
  }

  if (!procedureId && procedureNames.length > 0 && procedures.length === 0 && !input.allowUnscopedSpecialty) {
    throw new AgendaAvailabilityError(
      'PROCEDURE_NOT_FOUND',
      'Não foi possível identificar o procedimento para validar a agenda.',
      { procedureNames },
    );
  }

  return {
    procedureIds: procedures.map((procedure: any) => String(procedure.id)),
    specialtyIds: Array.from(new Set<string>(
      procedures.map((procedure: any) => String(procedure.especialidadeId || '').trim()).filter(Boolean),
    )),
  };
}

const agendaMatchesSpecialties = (agendaSpecialtyIds: string[], procedureSpecialtyIds: string[], allowUnscopedSpecialty: boolean) => {
  // An agenda without specialty metadata is a legacy generic agenda. It remains
  // valid for any procedure until the organization classifies that agenda.
  if (agendaSpecialtyIds.length === 0) return true;
  if (procedureSpecialtyIds.length === 0) return allowUnscopedSpecialty;
  return procedureSpecialtyIds.every((id) => agendaSpecialtyIds.includes(id));
};

const agendaResult = (agenda: any, doctor: any, weekday: string, procedureIds: string[], specialtyIds: string[]): AgendaAvailabilityResult => ({
  agendaId: String(agenda.id),
  branchId: String(agenda.branchId),
  doctorId: String(doctor.id),
  doctorName: String(doctor.name || ''),
  roomId: agenda.roomId ? String(agenda.roomId) : null,
  roomName: agenda.room?.name ? String(agenda.room.name) : null,
  weekday,
  shiftStart: String(agenda.shiftStart),
  shiftEnd: String(agenda.shiftEnd),
  specialtyIds,
  procedureIds,
});

export async function resolveAgendaAvailability(
  db: any,
  input: AgendaAvailabilityInput,
): Promise<AgendaAvailabilityResult> {
  const date = normalizeDate(input.date);
  if (!date) {
    throw new AgendaAvailabilityError('INVALID_DATE', 'Informe uma data válida no formato AAAA-MM-DD.', { date: input.date });
  }

  const time = normalizeTime(input.time);
  if (!time) {
    throw new AgendaAvailabilityError('INVALID_TIME', 'Informe um horário válido no formato HH:mm.', { time: input.time });
  }

  const durationMinutes = Math.max(1, Number(input.durationMinutes) || 30);
  const slotStart = timeToMinutes(time);
  const slotEnd = slotStart + durationMinutes;
  const doctor = await resolveDoctor(db, input);
  const procedure = await resolveProcedureSpecialties(db, input);
  const weekday = WEEKDAY_BY_DAY[new Date(`${date}T12:00:00Z`).getUTCDay()];

  const agendas = await db.agenda.findMany({
    where: {
      branchId: input.branchId,
      doctorId: doctor.id,
      status: 'ATIVA',
      ...(String(input.agendaId || '').trim() ? { id: String(input.agendaId).trim() } : {}),
    },
    include: { room: { select: { name: true } } },
    orderBy: [{ weekday: 'asc' }, { shiftStart: 'asc' }],
  });

  if (agendas.length === 0) {
    throw new AgendaAvailabilityError(
      'AGENDA_NOT_FOUND',
      'O profissional não possui uma agenda ativa cadastrada nessa unidade.',
      { branchId: input.branchId, doctorId: doctor.id },
    );
  }

  const weekdayAgendas = agendas.filter((agenda: any) => normalizeAgendaWeekday(agenda.weekday) === weekday);
  if (weekdayAgendas.length === 0) {
    throw new AgendaAvailabilityError(
      'AGENDA_DATE_UNAVAILABLE',
      'Não existe agenda ativa para o profissional nesse dia da semana.',
      { date, weekday, doctorId: doctor.id },
    );
  }

  const dateAgendas = weekdayAgendas.filter((agenda: any) => (
    dateIsWithinAgendaRange(date, agenda.startDate, agenda.endDate)
  ));
  if (dateAgendas.length === 0) {
    throw new AgendaAvailabilityError(
      'AGENDA_DATE_UNAVAILABLE',
      'A agenda do profissional não está vigente na data selecionada.',
      { date, doctorId: doctor.id },
    );
  }

  const timeAgendas = dateAgendas.filter((agenda: any) => {
    const start = normalizeTime(agenda.shiftStart);
    const end = normalizeTime(agenda.shiftEnd);
    if (!start || !end || timeToMinutes(end) <= timeToMinutes(start)) return false;
    return slotStart >= timeToMinutes(start) && slotEnd <= timeToMinutes(end);
  });
  if (timeAgendas.length === 0) {
    throw new AgendaAvailabilityError(
      'AGENDA_TIME_UNAVAILABLE',
      'O horário selecionado está fora do turno da agenda do profissional.',
      { date, time, durationMinutes, doctorId: doctor.id },
    );
  }

  const roomId = String(input.roomId || '').trim();
  const roomAgendas = roomId
    ? timeAgendas.filter((agenda: any) => !agenda.roomId || String(agenda.roomId) === roomId)
    : timeAgendas;
  if (roomId && roomAgendas.length === 0) {
    throw new AgendaAvailabilityError(
      'AGENDA_ROOM_MISMATCH',
      'A sala selecionada não pertence à agenda ativa desse profissional nesse horário.',
      { date, time, roomId, doctorId: doctor.id },
    );
  }

  const specialtyAgendas = roomAgendas.filter((agenda: any) => (
    agendaMatchesSpecialties(getAgendaSpecialtyIds(agenda), procedure.specialtyIds, Boolean(input.allowUnscopedSpecialty))
  ));
  if (specialtyAgendas.length === 0) {
    throw new AgendaAvailabilityError(
      'AGENDA_SPECIALTY_MISMATCH',
      'O procedimento selecionado não está vinculado à agenda ativa nesse horário.',
      {
        date,
        time,
        doctorId: doctor.id,
        procedureIds: procedure.procedureIds,
        specialtyIds: procedure.specialtyIds,
      },
    );
  }

  return agendaResult(
    specialtyAgendas[0],
    doctor,
    weekday,
    procedure.procedureIds,
    getAgendaSpecialtyIds(specialtyAgendas[0]),
  );
}

export async function listAgendaSlots(db: any, input: {
  branchId: string;
  agendaId?: string | null;
  doctorId?: string | null;
  doctorName?: string | null;
  procedureId?: string | null;
  procedureName?: string | null;
  specialty?: string | null;
  roomId?: string | null;
  fromDate: string;
  toDate: string;
  durationMinutes?: number | null;
  stepMinutes?: number | null;
  allowUnscopedSpecialty?: boolean;
}): Promise<AgendaAvailabilitySlot[]> {
  const fromDate = normalizeDate(input.fromDate);
  const toDate = normalizeDate(input.toDate);
  if (!fromDate || !toDate || fromDate > toDate) {
    throw new AgendaAvailabilityError(
      'INVALID_DATE',
      'Informe um intervalo de datas válido no formato AAAA-MM-DD.',
      { fromDate: input.fromDate, toDate: input.toDate },
    );
  }

  const durationMinutes = Math.max(1, Number(input.durationMinutes) || 30);
  const stepMinutes = Math.max(1, Number(input.stepMinutes) || 15);
  const doctor = await resolveDoctor(db, { ...input, date: fromDate, time: '00:00' });
  const procedure = await resolveProcedureSpecialties(db, { ...input, date: fromDate, time: '00:00' });
  const agendas = await db.agenda.findMany({
    where: {
      branchId: input.branchId,
      doctorId: doctor.id,
      status: 'ATIVA',
      ...(String(input.agendaId || '').trim() ? { id: String(input.agendaId).trim() } : {}),
    },
    include: { room: { select: { name: true } } },
    orderBy: [{ weekday: 'asc' }, { shiftStart: 'asc' }],
  });

  if (agendas.length === 0) {
    throw new AgendaAvailabilityError(
      'AGENDA_NOT_FOUND',
      'O profissional não possui uma agenda ativa cadastrada nessa unidade.',
      { branchId: input.branchId, doctorId: doctor.id },
    );
  }

  const slots: AgendaAvailabilitySlot[] = [];
  const roomId = String(input.roomId || '').trim();
  const cursor = new Date(`${fromDate}T12:00:00Z`);
  const endCursor = new Date(`${toDate}T12:00:00Z`);

  for (; cursor <= endCursor; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    const weekday = WEEKDAY_BY_DAY[cursor.getUTCDay()];
    const dateAgendas = agendas.filter((agenda: any) => (
      normalizeAgendaWeekday(agenda.weekday) === weekday
      && dateIsWithinAgendaRange(date, agenda.startDate, agenda.endDate)
    ));

    for (const agenda of dateAgendas) {
      const start = normalizeTime(agenda.shiftStart);
      const end = normalizeTime(agenda.shiftEnd);
      if (!start || !end || timeToMinutes(end) <= timeToMinutes(start)) continue;
      if (roomId && agenda.roomId && String(agenda.roomId) !== roomId) continue;
      if (!agendaMatchesSpecialties(
        getAgendaSpecialtyIds(agenda),
        procedure.specialtyIds,
        Boolean(input.allowUnscopedSpecialty),
      )) continue;

      for (let current = timeToMinutes(start); current + durationMinutes <= timeToMinutes(end); current += stepMinutes) {
        const time = `${String(Math.floor(current / 60)).padStart(2, '0')}:${String(current % 60).padStart(2, '0')}`;
        slots.push({
          ...agendaResult(agenda, doctor, weekday, procedure.procedureIds, getAgendaSpecialtyIds(agenda)),
          date,
          time,
        });
      }
    }
  }

  return slots.sort((a, b) => `${a.date}#${a.time}#${a.doctorName}`.localeCompare(`${b.date}#${b.time}#${b.doctorName}`));
}

export async function tryResolveAgendaAvailability(db: any, input: AgendaAvailabilityInput) {
  try {
    return await resolveAgendaAvailability(db, input);
  } catch (error) {
    if (error instanceof AgendaAvailabilityError) return null;
    throw error;
  }
}
