import { describe, expect, it, vi } from 'vitest';
import { runCheckMatriz } from '../../src/scripts/check-matriz';

describe('check-matriz script', () => {
  it('prints branch rows and closes pool', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { company_name: 'Empresa A', tradeName: 'Filial A', isMatriz: true, id: '1' },
      ],
    });
    const end = vi.fn().mockResolvedValue(undefined);
    const PoolCtor = vi.fn().mockImplementation(() => ({ query, end }));
    const logger = { log: vi.fn(), error: vi.fn() } as any;

    const rows = await runCheckMatriz({ PoolCtor: PoolCtor as any, logger });

    expect(rows).toHaveLength(1);
    expect(logger.log).toHaveBeenCalledWith('\n📋 Filiais no banco:');
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when query fails', async () => {
    const query = vi.fn().mockRejectedValue(new Error('db-fail'));
    const end = vi.fn().mockResolvedValue(undefined);
    const PoolCtor = vi.fn().mockImplementation(() => ({ query, end }));
    const logger = { log: vi.fn(), error: vi.fn() } as any;

    const rows = await runCheckMatriz({ PoolCtor: PoolCtor as any, logger });

    expect(rows).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('uses default logger when none provided', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const end = vi.fn().mockResolvedValue(undefined);
    const PoolCtor = vi.fn().mockImplementation(() => ({ query, end }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const rows = await runCheckMatriz({ PoolCtor: PoolCtor as any });

    expect(rows).toEqual([]);
    logSpy.mockRestore();
  });
});
