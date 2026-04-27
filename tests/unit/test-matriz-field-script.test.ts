import { describe, expect, it, vi } from 'vitest';
import { runTestMatrizField } from '../../src/scripts/test-matriz-field';

describe('test-matriz-field script', () => {
  it('returns first branch and logs matriz field info', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'b1', isMatriz: true }]);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const PrismaClientCtor = vi.fn().mockImplementation(() => ({
      branch: { findMany },
      $disconnect: disconnect,
    }));
    const logger = { log: vi.fn(), error: vi.fn() } as any;

    const branch = await runTestMatrizField({ PrismaClientCtor: PrismaClientCtor as any, logger });

    expect(branch).toEqual({ id: 'b1', isMatriz: true });
    expect(logger.log).toHaveBeenCalledWith('Valor de isMatriz:', true);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('returns null when no branches exist', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const PrismaClientCtor = vi.fn().mockImplementation(() => ({
      branch: { findMany },
      $disconnect: disconnect,
    }));
    const logger = { log: vi.fn(), error: vi.fn() } as any;

    const branch = await runTestMatrizField({ PrismaClientCtor: PrismaClientCtor as any, logger });

    expect(branch).toBeNull();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('returns null on failure and still disconnects', async () => {
    const findMany = vi.fn().mockRejectedValue(new Error('db-fail'));
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const PrismaClientCtor = vi.fn().mockImplementation(() => ({
      branch: { findMany },
      $disconnect: disconnect,
    }));
    const logger = { log: vi.fn(), error: vi.fn() } as any;

    const branch = await runTestMatrizField({ PrismaClientCtor: PrismaClientCtor as any, logger });

    expect(branch).toBeNull();
    expect(logger.error).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
