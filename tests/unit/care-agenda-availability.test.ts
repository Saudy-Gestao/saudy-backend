import { describe, expect, it, vi } from 'vitest';
import {
  AgendaAvailabilityError,
  listAgendaSlots,
  resolveAgendaAvailability,
} from '../../src/modules/care/lib/agenda-availability';

const makeDb = () => ({
  doctor: { findFirst: vi.fn().mockResolvedValue({ id: 'doctor-1', name: 'Dra. Ana' }) },
  procedure: { findMany: vi.fn().mockResolvedValue([{ id: 'procedure-1', name: 'Psicologia', especialidadeId: 'specialty-1' }]) },
  agenda: { findMany: vi.fn().mockResolvedValue([{
    id: 'agenda-1',
    branchId: 'branch-1',
    doctorId: 'doctor-1',
    weekday: 'SEGUNDA',
    shiftStart: '08:00',
    shiftEnd: '12:00',
    startDate: new Date('2026-01-01T00:00:00Z'),
    endDate: new Date('2026-12-31T00:00:00Z'),
    especialidadeId: null,
    especialidadeIds: ['specialty-1'],
    roomId: 'room-1',
    room: { name: 'Sala 1' },
  }]) },
});

describe('agenda availability resolver', () => {
  it('resolves a slot from the active agenda and specialty', async () => {
    const db = makeDb();

    const result = await resolveAgendaAvailability(db, {
      branchId: 'branch-1',
      doctorId: 'doctor-1',
      procedureId: 'procedure-1',
      date: '2026-04-13',
      time: '09:00',
      durationMinutes: 45,
    });

    expect(result).toMatchObject({
      agendaId: 'agenda-1',
      doctorId: 'doctor-1',
      roomId: 'room-1',
      specialtyIds: ['specialty-1'],
    });
  });

  it('rejects a slot whose procedure specialty is not on the agenda', async () => {
    const db = makeDb();
    db.procedure.findMany.mockResolvedValueOnce([{
      id: 'procedure-2',
      name: 'Fisioterapia',
      especialidadeId: 'specialty-2',
    }]);

    await expect(resolveAgendaAvailability(db, {
      branchId: 'branch-1',
      doctorId: 'doctor-1',
      procedureId: 'procedure-2',
      date: '2026-04-13',
      time: '09:00',
      durationMinutes: 30,
    })).rejects.toMatchObject<AgendaAvailabilityError>({
      code: 'AGENDA_SPECIALTY_MISMATCH',
    });
  });

  it('accepts a multi-specialty appointment only when the agenda covers every selected specialty', async () => {
    const db = makeDb();
    db.procedure.findMany.mockResolvedValueOnce([
      { id: 'procedure-1', name: 'Psicologia', especialidadeId: 'specialty-1' },
      { id: 'procedure-2', name: 'Psicomotricidade', especialidadeId: 'specialty-2' },
    ]);
    db.agenda.findMany.mockResolvedValueOnce([{
      id: 'agenda-multi',
      branchId: 'branch-1',
      doctorId: 'doctor-1',
      weekday: 'SEGUNDA',
      shiftStart: '08:00',
      shiftEnd: '12:00',
      startDate: new Date('2026-01-01T00:00:00Z'),
      endDate: new Date('2026-12-31T00:00:00Z'),
      especialidadeId: null,
      especialidadeIds: ['specialty-1', 'specialty-2'],
      roomId: 'room-1',
      room: { name: 'Sala 1' },
    }]);

    const result = await resolveAgendaAvailability(db, {
      branchId: 'branch-1',
      doctorId: 'doctor-1',
      procedureName: 'Psicologia,Psicomotricidade',
      date: '2026-04-13',
      time: '09:00',
      durationMinutes: 30,
    });

    expect(result).toMatchObject({
      agendaId: 'agenda-multi',
      specialtyIds: ['specialty-1', 'specialty-2'],
      procedureIds: ['procedure-1', 'procedure-2'],
    });
  });

  it('lists only slots that fit inside the active agenda range', async () => {
    const db = makeDb();

    const slots = await listAgendaSlots(db, {
      branchId: 'branch-1',
      doctorId: 'doctor-1',
      procedureId: 'procedure-1',
      fromDate: '2026-04-13',
      toDate: '2026-04-14',
      durationMinutes: 60,
      stepMinutes: 60,
    });

    expect(slots.map((slot) => `${slot.date} ${slot.time}`)).toEqual([
      '2026-04-13 08:00',
      '2026-04-13 09:00',
      '2026-04-13 10:00',
      '2026-04-13 11:00',
    ]);
  });
});
