import { beforeEach, describe, expect, it, vi } from 'vitest';

const onMock = vi.fn();
const poolCtorMock = vi.fn().mockImplementation(() => ({
  on: onMock,
}));

const prismaPgCtorMock = vi.fn().mockImplementation((pool) => ({ pool }));

vi.mock('pg', () => ({
  Pool: poolCtorMock,
}));

vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: prismaPgCtorMock,
}));

describe('createPrismaAdapter', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_SSL;
  });

  it('creates pool without ssl by default', async () => {
    process.env.DATABASE_URL = 'postgres://db-url';

    const { createPrismaAdapter } = await import('../../src/lib/prisma-adapter');
    const adapter = createPrismaAdapter();

    expect(poolCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgres://db-url',
        ssl: undefined,
      }),
    );
    expect(prismaPgCtorMock).toHaveBeenCalledTimes(1);
    expect(adapter).toEqual({ pool: expect.any(Object) });
  });

  it('enables ssl when DATABASE_SSL=true and sets search_path on connect', async () => {
    process.env.DATABASE_URL = 'postgres://db-url';
    process.env.DATABASE_SSL = 'true';

    const { createPrismaAdapter } = await import('../../src/lib/prisma-adapter');
    createPrismaAdapter();

    expect(poolCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ssl: { rejectUnauthorized: false },
      }),
    );

    const connectHandler = onMock.mock.calls.find((call) => call[0] === 'connect')?.[1];
    expect(connectHandler).toBeTypeOf('function');

    const query = vi.fn();
    connectHandler({ query });
    expect(query).toHaveBeenCalledWith('SET search_path TO "public"');
  });
});
