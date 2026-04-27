import { describe, expect, it, vi } from 'vitest';
import { runCheckUser } from '../../scripts/check-user.mjs';

describe('check-user script', () => {
  it('queries users by identifier and logs json output', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'u1' }]);
    const disconnect = vi.fn().mockResolvedValue(undefined);

    const PrismaClientCtor = vi.fn().mockImplementation(() => ({
      user: { findMany },
      $disconnect: disconnect,
    }));

    const logger = { log: vi.fn(), error: vi.fn() };

    const users = await runCheckUser({
      PrismaClientCtor,
      argv: ['node', 'check-user.mjs', '111.222.333-44'],
      logger,
    });

    expect(users).toEqual([{ id: 'u1' }]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { email: { equals: '111.222.333-44', mode: 'insensitive' } },
            { cpf: '11122233344' },
            { cpf: '111.222.333-44' },
          ],
        },
      }),
    );
    expect(logger.log).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('sets exit code on query failure and still disconnects', async () => {
    const findMany = vi.fn().mockRejectedValue(new Error('db-error'));
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const setExitCode = vi.fn();
    const logger = { log: vi.fn(), error: vi.fn() };

    const PrismaClientCtor = vi.fn().mockImplementation(() => ({
      user: { findMany },
      $disconnect: disconnect,
    }));

    const users = await runCheckUser({
      PrismaClientCtor,
      argv: ['node', 'check-user.mjs'],
      logger,
      setExitCode,
    });

    expect(users).toEqual([]);
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('uses default exitCode setter when setExitCode is not provided', async () => {
    const findMany = vi.fn().mockRejectedValue(new Error('db-error'));
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const logger = { log: vi.fn(), error: vi.fn() };

    const PrismaClientCtor = vi.fn().mockImplementation(() => ({
      user: { findMany },
      $disconnect: disconnect,
    }));

    const originalExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      const users = await runCheckUser({
        PrismaClientCtor,
        argv: ['node', 'check-user.mjs'],
        logger,
      });

      expect(users).toEqual([]);
      expect(process.exitCode).toBe(1);
      expect(logger.error).toHaveBeenCalled();
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });
});
