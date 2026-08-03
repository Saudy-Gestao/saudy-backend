import { beforeEach, describe, expect, it, vi } from 'vitest';

const defineConfigMock = vi.fn((config) => config);

vi.mock('prisma/config', () => ({
  defineConfig: defineConfigMock,
}));

describe('prisma.config', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.DATABASE_URL;
    delete process.env.DIRECT_URL;
  });

  it('prefers DIRECT_URL over DATABASE_URL when both are provided', async () => {
    process.env.DATABASE_URL = 'postgresql://pooled-db-url';
    process.env.DIRECT_URL = 'postgresql://direct-db-url';

    const mod = await import('../../prisma.config');

    expect(defineConfigMock).toHaveBeenCalledTimes(1);
    expect((mod.default as any).datasource.url).toBe('postgresql://direct-db-url');
  });

  it('falls back to DATABASE_URL when DIRECT_URL is missing', async () => {
    process.env.DATABASE_URL = 'postgresql://custom-db-url';

    const mod = await import('../../prisma.config');

    expect((mod.default as any).datasource.url).toBe('postgresql://custom-db-url');
  });

  it('uses fallback database url when env is missing', async () => {
    const mod = await import('../../prisma.config');

    expect((mod.default as any).datasource.url).toBe(
      'postgresql://saudy_user:saudy_password@localhost:5432/saudy_db',
    );
  });
});
