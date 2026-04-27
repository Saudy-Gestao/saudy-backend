import { describe, expect, it, vi } from 'vitest';
import { runUpdateMatrizFlags } from '../../src/scripts/update-matriz';

describe('update-matriz script', () => {
  it('marks first branch as matriz and others as non-matriz', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        tradeName: 'Empresa A',
        branches: [
          { id: 'b1', tradeName: 'Filial 1' },
          { id: 'b2', tradeName: 'Filial 2' },
        ],
      },
    ]);
    const update = vi.fn().mockResolvedValue({});
    const disconnect = vi.fn().mockResolvedValue(undefined);

    const PrismaClientCtor = vi.fn().mockImplementation(() => ({
      company: { findMany },
      branch: { update },
      $disconnect: disconnect,
    }));

    const logger = { log: vi.fn(), error: vi.fn() } as any;

    await runUpdateMatrizFlags({ PrismaClientCtor: PrismaClientCtor as any, logger });

    expect(update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { isMatriz: true } });
    expect(update).toHaveBeenCalledWith({ where: { id: 'b2' }, data: { isMatriz: false } });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('handles company with exactly one branch (no others to mark non-matriz)', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { tradeName: 'Empresa B', branches: [{ id: 'b3', tradeName: 'Unica' }] },
    ]);
    const update = vi.fn().mockResolvedValue({});
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const PrismaClientCtor = vi.fn().mockImplementation(() => ({
      company: { findMany },
      branch: { update },
      $disconnect: disconnect,
    }));
    const logger = { log: vi.fn(), error: vi.fn() } as any;

    await runUpdateMatrizFlags({ PrismaClientCtor: PrismaClientCtor as any, logger });

    expect(update).toHaveBeenCalledWith({ where: { id: 'b3' }, data: { isMatriz: true } });
    // only 1 update call (no second branch to mark false)
    expect(update).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('handles company with no branches', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { tradeName: 'Empresa Vazia', branches: [] },
    ]);
    const update = vi.fn();
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const PrismaClientCtor = vi.fn().mockImplementation(() => ({
      company: { findMany },
      branch: { update },
      $disconnect: disconnect,
    }));
    const logger = { log: vi.fn(), error: vi.fn() } as any;

    await runUpdateMatrizFlags({ PrismaClientCtor: PrismaClientCtor as any, logger });

    expect(update).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('logs error path and disconnects', async () => {
    const findMany = vi.fn().mockRejectedValue(new Error('db-fail'));
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const PrismaClientCtor = vi.fn().mockImplementation(() => ({
      company: { findMany },
      branch: { update: vi.fn() },
      $disconnect: disconnect,
    }));

    const logger = { log: vi.fn(), error: vi.fn() } as any;

    await runUpdateMatrizFlags({ PrismaClientCtor: PrismaClientCtor as any, logger });

    expect(logger.error).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
