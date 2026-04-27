import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MwlScp } from '../../src/modules/dicom/mwl';
import prisma from '../../src/lib/prisma';

vi.mock('../../src/lib/prisma', () => ({
  default: {
    mwlEntry: {
      findMany: vi.fn(),
    },
  },
}));

const mockedPrisma = prisma as any;

describe('MwlScp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts and stops stub service', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const scp = new MwlScp();

    scp.start();
    scp.stop();

    expect(logSpy).toHaveBeenCalledWith('MWL stub service started (DICOM SCP not implemented).');
    expect(logSpy).toHaveBeenCalledWith('MWL stub service stopped.');
    logSpy.mockRestore();
  });

  it('builds query filters and fetches entries', async () => {
    mockedPrisma.mwlEntry.findMany.mockResolvedValue([{ id: 'row-1' }]);
    const scp = new MwlScp();

    const result = await scp.queryMwlEntries({
      accessionNumber: 'ACC-1',
      patientId: '123',
      patientName: 'Maria',
      modality: 'MR',
    });

    expect(result).toEqual([{ id: 'row-1' }]);
    expect(mockedPrisma.mwlEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          status: { not: 'cancelado' },
          accessionNumber: 'ACC-1',
          patientCpf: '123',
          patientName: { contains: 'Maria', mode: 'insensitive' },
          examType: { contains: 'MR', mode: 'insensitive' },
        }),
      }),
    );
  });

  it('uses default where clause when optional filters are absent', async () => {
    mockedPrisma.mwlEntry.findMany.mockResolvedValue([]);
    const scp = new MwlScp();

    await scp.queryMwlEntries({});

    expect(mockedPrisma.mwlEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isActive: true,
          status: { not: 'cancelado' },
        },
      }),
    );
  });
});
