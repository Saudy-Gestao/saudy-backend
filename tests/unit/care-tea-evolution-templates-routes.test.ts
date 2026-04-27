import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import teaEvolutionTemplateRoutes from '../../src/modules/care/routes/tea-evolution-templates';
import prisma from '../../src/modules/care/lib/prisma';

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    procedure: { findMany: vi.fn(), findFirst: vi.fn() },
    teaEvolutionTemplate: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
  },
}));

const mockedPrisma = prisma as any;

async function buildApp(opts?: { unauthorized?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1' };
  });
  await app.register(teaEvolutionTemplateRoutes, { prefix: '/tea-evolution-templates' });
  return app;
}

describe('care tea-evolution-templates routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b-1' } } });
    mockedPrisma.procedure.findMany.mockResolvedValue([{ id: 'p-1', name: 'Terapia TEA' }]);
    mockedPrisma.procedure.findFirst.mockResolvedValue({ id: 'p-1', name: 'Terapia TEA' });
    mockedPrisma.teaEvolutionTemplate.findMany.mockResolvedValue([{ id: 't-1' }]);
    mockedPrisma.teaEvolutionTemplate.count.mockResolvedValue(1);
    mockedPrisma.teaEvolutionTemplate.findFirst.mockResolvedValue(null);
    mockedPrisma.teaEvolutionTemplate.upsert.mockResolvedValue({ id: 't-1' });
    mockedPrisma.teaEvolutionTemplate.update.mockResolvedValue({ id: 't-1' });
  });

  it('handles auth hook, list and resolve', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/tea-evolution-templates' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    const app = await buildApp();
    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/tea-evolution-templates' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/tea-evolution-templates?search=tea&isActive=true' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    res = await app.inject({ method: 'GET', url: '/tea-evolution-templates/resolve' });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'GET', url: '/tea-evolution-templates/resolve?procedureName=terapia' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('creates and updates templates with validation', async () => {
    const app = await buildApp();

    mockedPrisma.procedure.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'POST', url: '/tea-evolution-templates', payload: { procedureId: 'p-x' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/tea-evolution-templates',
      payload: { procedureId: 'p-1', strategiesUsed: [' A ', ''] },
    });
    expect(res.statusCode).toBe(201);

    mockedPrisma.teaEvolutionTemplate.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'PUT', url: '/tea-evolution-templates/t-1', payload: { name: 'x' } });
    expect(res.statusCode).toBe(404);

    mockedPrisma.teaEvolutionTemplate.findFirst.mockResolvedValueOnce({ id: 't-1', isActive: true, strategiesUsed: [] });
    res = await app.inject({ method: 'PUT', url: '/tea-evolution-templates/t-1', payload: { strategiesUsed: ['  B  '] } });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('deactivates template', async () => {
    const app = await buildApp();

    mockedPrisma.teaEvolutionTemplate.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'DELETE', url: '/tea-evolution-templates/t-1' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.teaEvolutionTemplate.findFirst.mockResolvedValueOnce({ id: 't-1' });
    res = await app.inject({ method: 'DELETE', url: '/tea-evolution-templates/t-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toContain('deactivated');

    await app.close();
  });
});
