import { describe, expect, it, vi } from 'vitest';
import { iso, runReleaseStaleTeaSlots } from '../../scripts/release-stale-tea-slots';

describe('release-stale-tea-slots.ts', () => {
  it('formats date with iso helper', () => {
    expect(iso(new Date('2026-02-09T12:00:00Z'))).toBe('2026-02-09');
  });

  it('processes rows and aggregates canceled appointments', async () => {
    const prismaClient = {
      teaPreReservation: {
        findMany: vi.fn().mockResolvedValue([
          {
            patientId: 'p1',
            suggestedDate: new Date('2026-02-09T00:00:00Z'),
            suggestedTime: '09:00',
            professionalName: null,
          },
        ]),
      },
      appointment: {
        updateMany: vi.fn().mockResolvedValue({ count: 3 }),
      },
    } as any;
    const logger = { log: vi.fn(), error: vi.fn() } as any;

    const result = await runReleaseStaleTeaSlots({ prismaClient, logger });

    expect(result).toEqual({ scannedReservations: 1, canceledAppointments: 3 });
    expect(prismaClient.appointment.updateMany).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalled();
  });

  it('skips incomplete rows and includes professionalName in conflict clauses', async () => {
    const prismaClient = {
      teaPreReservation: {
        findMany: vi.fn().mockResolvedValue([
          {
            patientId: 'p1',
            suggestedDate: new Date('2026-02-10T00:00:00Z'),
            suggestedTime: '10:00',
            professionalName: 'Dr B',
          },
          {
            patientId: 'p2',
            suggestedDate: null,
            suggestedTime: null,
            professionalName: null,
          },
        ]),
      },
      appointment: {
        updateMany: vi.fn().mockResolvedValue({}),
      },
    } as any;
    const logger = { log: vi.fn(), error: vi.fn() } as any;

    const result = await runReleaseStaleTeaSlots({ prismaClient, logger });

    expect(result).toEqual({ scannedReservations: 2, canceledAppointments: 0 });
    expect(prismaClient.appointment.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaClient.appointment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ patientId: 'p1' }, { doctorName: 'Dr B' }],
        }),
      }),
    );
  });
});

