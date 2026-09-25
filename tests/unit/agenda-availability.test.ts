import { describe, expect, it, vi } from 'vitest';
import { listAgendaSlots, resolveAgendaAvailability } from '../../src/modules/care/lib/agenda-availability';

const baseAgenda = {
  branchId: 'branch-1',
  doctorId: 'doctor-1',
  weekday: 'segunda',
  startDate: null,
  endDate: null,
  status: 'ATIVA',
  especialidadeIds: ['specialty-1'],
  especialidadeId: 'specialty-1',
  roomId: null,
  room: null,
};

const makeDb = () => {
  const agendas = [
    {
      ...baseAgenda,
      id: 'agenda-professional',
      internId: null,
      intern: null,
      shiftStart: '08:00',
      shiftEnd: '18:00',
    },
    {
      ...baseAgenda,
      id: 'agenda-intern',
      internId: 'intern-1',
      intern: { id: 'intern-1', name: 'Bia Estagiária' },
      shiftStart: '12:00',
      shiftEnd: '18:00',
    },
  ];

  return {
    doctor: {
      findFirst: vi.fn().mockResolvedValue({ id: 'doctor-1', name: 'Dra. Ana' }),
    },
    procedure: {
      findMany: vi.fn().mockResolvedValue([{ id: 'procedure-1', name: 'Consulta', especialidadeId: 'specialty-1' }]),
    },
    agenda: {
      findMany: vi.fn().mockResolvedValue(agendas),
    },
  };
};

const input = {
  branchId: 'branch-1',
  doctorId: 'doctor-1',
  procedureId: 'procedure-1',
  date: '2026-09-28',
  time: '09:00',
  durationMinutes: 60,
};

describe('agenda availability with intern overrides', () => {
  it('returns the professional before the override and the intern inside it', async () => {
    const db = makeDb();

    const professional = await resolveAgendaAvailability(db, input);
    const intern = await resolveAgendaAvailability(db, { ...input, time: '13:00' });

    expect(professional.internId).toBeNull();
    expect(professional.agendaId).toBe('agenda-professional');
    expect(intern.internId).toBe('intern-1');
    expect(intern.internName).toBe('Bia Estagiária');
    expect(intern.agendaId).toBe('agenda-intern');
  });

  it('removes overlapping professional slots from the generated availability', async () => {
    const db = makeDb();

    const slots = await listAgendaSlots(db, {
      branchId: 'branch-1',
      doctorId: 'doctor-1',
      procedureId: 'procedure-1',
      fromDate: '2026-09-28',
      toDate: '2026-09-28',
      durationMinutes: 60,
      stepMinutes: 60,
    });

    expect(slots.filter((slot) => slot.internId === null).map((slot) => slot.time)).toEqual(['08:00', '09:00', '10:00', '11:00']);
    expect(slots.filter((slot) => slot.internId === 'intern-1').map((slot) => slot.time)).toEqual(['12:00', '13:00', '14:00', '15:00', '16:00', '17:00']);
  });
});
