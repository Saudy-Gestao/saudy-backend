import { createRequire } from 'module';
import { describe, expect, it, vi } from 'vitest';

const requireCjs = createRequire(import.meta.url);
const { iso, runReleaseStaleTeaSlots } = requireCjs('../../scripts/release-stale-tea-slots.cjs');

describe('release-stale-tea-slots.cjs', () => {
  it('formats date with iso helper', () => {
    expect(iso(new Date('2026-01-05T10:00:00Z'))).toBe('2026-01-05');
  });

  it('cancels matching appointments and skips incomplete reservations', async () => {
    const teaPreReservation = {
      findMany: vi.fn().mockResolvedValue([
        {
          patientId: 'p1',
          suggestedDate: new Date('2026-01-10T00:00:00Z'),
          suggestedTime: '10:30',
          professionalName: 'Dr A',
        },
        {
          patientId: 'p2',
          suggestedDate: null,
          suggestedTime: null,
          professionalName: null,
        },
      ]),
    };
    const appointment = {
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
    };
    const prisma = { teaPreReservation, appointment };
    const logger = { log: vi.fn(), error: vi.fn() };

    const result = await runReleaseStaleTeaSlots({ prisma, logger });

    expect(result).toEqual({ scannedReservations: 2, canceledAppointments: 2 });
    expect(appointment.updateMany).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalled();
  });

  it('treats missing update count as zero', async () => {
    const teaPreReservation = {
      findMany: vi.fn().mockResolvedValue([
        {
          patientId: 'p3',
          suggestedDate: new Date('2026-01-12T00:00:00Z'),
          suggestedTime: '14:00',
          professionalName: null,
        },
      ]),
    };
    const appointment = {
      updateMany: vi.fn().mockResolvedValue({}),
    };
    const prisma = { teaPreReservation, appointment };
    const logger = { log: vi.fn(), error: vi.fn() };

    const result = await runReleaseStaleTeaSlots({ prisma, logger });

    expect(result).toEqual({ scannedReservations: 1, canceledAppointments: 0 });
    expect(appointment.updateMany).toHaveBeenCalledTimes(1);
  });
});

