import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const requireCjs = createRequire(import.meta.url);
const { verifyMigrations } = requireCjs('../../scripts/verify-migrations.cjs');

describe('verify-migrations script', () => {
  it('fails when migrations directory is missing', () => {
    const logger = { error: vi.fn(), log: vi.fn() };
    const code = verifyMigrations({
      fs: { existsSync: vi.fn().mockReturnValue(false) },
      path: { join: (...parts: string[]) => parts.join('/') },
      logger,
      root: '/repo',
      databaseUrl: '',
    });

    expect(code).toBe(1);
    expect(logger.error).toHaveBeenCalledWith('prisma/migrations directory not found.');
  });

  it('fails when a migration directory has no migration.sql', () => {
    const logger = { error: vi.fn(), log: vi.fn() };
    const existsSync = vi.fn((file: string) => !file.endsWith('/bad/migration.sql'));
    const code = verifyMigrations({
      fs: {
        existsSync,
        readdirSync: vi.fn().mockReturnValue([
          { isDirectory: () => true, name: 'good' },
          { isDirectory: () => true, name: 'bad' },
        ]),
      },
      path: { join: (...parts: string[]) => parts.join('/') },
      logger,
      root: '/repo',
      databaseUrl: '',
    });

    expect(code).toBe(1);
    expect(logger.error).toHaveBeenCalledWith('Found migration directories without migration.sql:');
  });

  it('skips prisma migrate status when DATABASE_URL is not set', () => {
    const logger = { error: vi.fn(), log: vi.fn() };
    const code = verifyMigrations({
      fs: {
        existsSync: vi.fn().mockReturnValue(true),
        readdirSync: vi.fn().mockReturnValue([]),
      },
      path: { join: (...parts: string[]) => parts.join('/') },
      logger,
      root: '/repo',
      databaseUrl: '',
    });

    expect(code).toBe(0);
    expect(logger.log).toHaveBeenCalledWith(
      'DATABASE_URL not set. Folder integrity verified; skipping prisma migrate status.',
    );
  });

  it('returns prisma migrate status code and success path', () => {
    const logger = { error: vi.fn(), log: vi.fn() };
    const spawnSync = vi.fn().mockReturnValueOnce({ status: 2 }).mockReturnValueOnce({ status: 0 });

    const common = {
      fs: {
        existsSync: vi.fn().mockReturnValue(true),
        readdirSync: vi.fn().mockReturnValue([]),
      },
      path: { join: (...parts: string[]) => parts.join('/') },
      logger,
      root: '/repo',
      databaseUrl: 'postgres://db',
      spawnSync,
    };

    expect(verifyMigrations(common)).toBe(2);
    expect(verifyMigrations(common)).toBe(0);
    expect(logger.log).toHaveBeenCalledWith('Migrations verification passed.');
  });
});
