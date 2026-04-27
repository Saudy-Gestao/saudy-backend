import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const requireCjs = createRequire(import.meta.url);
const { runCheckColumns } = requireCjs('../../src/scripts/check-columns.js');

describe('check-columns script', () => {
  it('logs table columns on success', () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const exec = vi.fn((_: string, __: unknown, cb: Function) => cb(null, 'table-output', ''));

    runCheckColumns({ exec, logger, env: {} });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith('📋 Colunas da tabela branches:');
    expect(logger.log).toHaveBeenCalledWith('table-output');
  });

  it('logs error and stderr paths', () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const exec = vi
      .fn()
      .mockImplementationOnce((_: string, __: unknown, cb: Function) => cb(new Error('boom'), '', ''))
      .mockImplementationOnce((_: string, __: unknown, cb: Function) => cb(null, '', 'stderr-output'));

    runCheckColumns({ exec, logger, env: {} });
    runCheckColumns({ exec, logger, env: {} });

    expect(logger.error).toHaveBeenCalledWith('Erro:', 'boom');
    expect(logger.error).toHaveBeenCalledWith('Stderr:', 'stderr-output');
  });
});
