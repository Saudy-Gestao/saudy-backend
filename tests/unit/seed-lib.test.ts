import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrismaInstance = {
  module: {
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  $disconnect: vi.fn(),
};

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockPrismaInstance),
}));

vi.mock('pg', () => ({
  Pool: vi.fn(() => ({})),
}));

vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: vi.fn(() => ({})),
}));

describe('seed lib', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockPrismaInstance.module.upsert.mockResolvedValue({});
    mockPrismaInstance.module.deleteMany.mockResolvedValue({ count: 0 });
    mockPrismaInstance.$disconnect.mockResolvedValue(undefined);
  });

  it('runs seed creating all modules and no removal log when count is zero', async () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const seed = await import('../../src/lib/seed.js');

    await seed.runSeed({ client: mockPrismaInstance, logger });

    expect(mockPrismaInstance.module.upsert).toHaveBeenCalledTimes(seed.modules.length);
    expect(mockPrismaInstance.module.deleteMany).toHaveBeenCalledWith({
      where: { name: { in: ['envelopamento', 'documentos'] } },
    });
    expect(logger.log).toHaveBeenCalledWith('🌱 Starting seed...');
    expect(logger.log).toHaveBeenCalledWith('✅ Seed completed!');
    expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('descontinuado'));
  });

  it('contains BI module in seed catalog', async () => {
    const seed = await import('../../src/lib/seed.js');
    expect(seed.modules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'bi-gestao',
          label: 'BI Gestão',
          category: 'administrativo',
        }),
      ]),
    );
  });

  it('logs removed modules when deleteMany returns count > 0', async () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const seed = await import('../../src/lib/seed.js');
    mockPrismaInstance.module.deleteMany.mockResolvedValue({ count: 2 });

    await seed.runSeed({ client: mockPrismaInstance, logger });

    expect(logger.log).toHaveBeenCalledWith('  ✓ 2 módulo(s) descontinuado(s) removido(s) do catálogo');
  });

  it('runs cli seed using internal prisma instance', async () => {
    const seed = await import('../../src/lib/seed.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await seed.runCliSeed();

    expect(logSpy).toHaveBeenCalledWith('🌱 Starting seed...');
    expect(logSpy).toHaveBeenCalledWith('✅ Seed completed!');

    logSpy.mockRestore();
  });

  it('runs seed with default client and logger parameters', async () => {
    const seed = await import('../../src/lib/seed.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await seed.runSeed();

    expect(logSpy).toHaveBeenCalledWith('🌱 Starting seed...');
    expect(logSpy).toHaveBeenCalledWith('✅ Seed completed!');

    logSpy.mockRestore();
  });

  it('loads module with explicit DATABASE_URL branch', async () => {
    process.env.DATABASE_URL = 'postgres://seed-coverage';
    vi.resetModules();

    await import('../../src/lib/seed.js');

    delete process.env.DATABASE_URL;
  });

});
