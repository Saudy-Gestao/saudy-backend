import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const requireCjs = createRequire(import.meta.url);
const { runVerifyMatriz } = requireCjs('../../src/scripts/verify-matriz.js');

describe('verify-matriz script', () => {
  it('returns query rows on success and closes pool', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'b1' }] });
    const end = vi.fn().mockResolvedValue(undefined);
    const PoolCtor = vi.fn().mockImplementation(() => ({ query, end }));
    const logger = { log: vi.fn(), error: vi.fn() };

    const rows = await runVerifyMatriz({ PoolCtor, logger });

    expect(rows).toEqual([{ id: 'b1' }]);
    expect(query).toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('logs error and returns empty array on failure', async () => {
    const query = vi.fn().mockRejectedValue(new Error('db-fail'));
    const end = vi.fn().mockResolvedValue(undefined);
    const PoolCtor = vi.fn().mockImplementation(() => ({ query, end }));
    const logger = { log: vi.fn(), error: vi.fn() };

    const rows = await runVerifyMatriz({ PoolCtor, logger });

    expect(rows).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith('❌ Erro:', 'db-fail');
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('uses default logger when none provided', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const end = vi.fn().mockResolvedValue(undefined);
    const PoolCtor = vi.fn().mockImplementation(() => ({ query, end }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const rows = await runVerifyMatriz({ PoolCtor });

    expect(rows).toEqual([]);
    logSpy.mockRestore();
  });
});
