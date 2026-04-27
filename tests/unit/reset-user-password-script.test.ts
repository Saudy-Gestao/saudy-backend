import { describe, expect, it, vi } from 'vitest';
import { digitsOnly, isEmail, runResetUserPassword } from '../../src/scripts/reset-user-password';

describe('reset-user-password script', () => {
  it('validates helpers', () => {
    expect(digitsOnly('111.222.333-44')).toBe('11122233344');
    expect(isEmail('foo@bar.com')).toBe(true);
    expect(isEmail('11122233344')).toBe(false);
  });

  it('exits when arguments are missing', async () => {
    const exit = vi.fn();
    const logger = { log: vi.fn(), error: vi.fn() } as any;

    await runResetUserPassword({ argv: ['node', 'script'], exit, logger });

    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it('updates users found by email', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'u1', email: ' USER@A.COM ', cpf: '1' }]);
    const update = vi.fn().mockResolvedValue({});
    const transaction = vi.fn().mockResolvedValue(undefined);
    const prismaClient = {
      user: { findMany, update },
      $transaction: transaction,
    } as any;
    const bcryptLib = { hash: vi.fn().mockResolvedValue('hashed') } as any;
    const logger = { log: vi.fn(), error: vi.fn() } as any;

    const users = await runResetUserPassword({
      argv: ['node', 'script', 'user@a.com', 'new-pass'],
      prismaClient,
      bcryptLib,
      logger,
      exit: vi.fn(),
    });

    expect(users).toHaveLength(1);
    expect(bcryptLib.hash).toHaveBeenCalledWith('new-pass', 10);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'user@a.com',
          password: 'hashed',
        }),
      }),
    );
  });

  it('exits when no users are found', async () => {
    const exit = vi.fn();
    const prismaClient = {
      user: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(),
    } as any;
    const logger = { log: vi.fn(), error: vi.fn() } as any;

    await runResetUserPassword({
      argv: ['node', 'script', '111.222.333-44', 'new-pass'],
      prismaClient,
      logger,
      exit,
    });

    expect(exit).toHaveBeenCalledWith(1);
  });
});

