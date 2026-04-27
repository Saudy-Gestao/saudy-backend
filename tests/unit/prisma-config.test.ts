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
  });

  it('uses DATABASE_URL when provided', async () => {
    process.env.DATABASE_URL = 'postgresql://custom-db-url';

    const mod = await import('../../prisma.config');

    expect(defineConfigMock).toHaveBeenCalledTimes(1);
    expect((mod.default as any).datasource.url).toBe('postgresql://custom-db-url');
  });

  it('uses fallback database url when env is missing', async () => {
    const mod = await import('../../prisma.config');

    expect((mod.default as any).datasource.url).toBe(
      'postgresql://saudy_user:saudy_password@localhost:5432/saudy_db',
    );
  });
});
