import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import leadRoutes from '../../src/modules/admin/routes/leads';
import prisma from '../../src/modules/admin/lib/prisma';

vi.mock('../../src/modules/admin/lib/prisma', () => ({
  default: {
    lead: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

const mockedPrisma = prisma as any;

async function buildApp() {
  const app = Fastify();
  app.decorateRequest('jwtVerify', async function jwtVerify() {});
  app.addSchema({ $id: 'Lead', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'LeadCreate', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'LeadStatusUpdate', type: 'object', additionalProperties: true });

  await app.register(leadRoutes, { prefix: '/leads' });
  return app;
}

describe('admin leads routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists leads with search/status', async () => {
    mockedPrisma.lead.findMany.mockResolvedValue([{ id: '1' }]);
    mockedPrisma.lead.count.mockResolvedValue(1);

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/leads?search=ana&status=NEW&limit=10&offset=5' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [{ id: '1' }], total: 1, limit: 10, offset: 5 });

    res = await app.inject({ method: 'GET', url: '/leads?status=ALL' });
    expect(res.statusCode).toBe(200);
    expect(res.json().limit).toBe(50);
    expect(res.json().offset).toBe(0);

    await app.close();
  });

  it('creates lead and validates required fields', async () => {
    mockedPrisma.lead.create.mockResolvedValue({ id: '1' });

    const app = await buildApp();

    let res = await app.inject({
      method: 'POST',
      url: '/leads',
      payload: { name: '', email: 'bad', phone: '', message: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Validation failed');

    res = await app.inject({
      method: 'POST',
      url: '/leads',
      payload: {
        name: ' Ana ',
        email: ' ANA@MAIL.COM ',
        phone: ' 11999999999 ',
        message: ' Quero saber mais ',
        source: '  ',
        companyName: ' Empresa ',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(mockedPrisma.lead.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: 'Ana',
        email: 'ana@mail.com',
        source: 'Landing page',
      }),
    }));

    await app.close();
  });

  it('updates lead status with validation and not found', async () => {
    mockedPrisma.lead.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: '1' });
    mockedPrisma.lead.update.mockResolvedValue({ id: '1', status: 'QUALIFIED' });

    const app = await buildApp();

    let res = await app.inject({ method: 'PATCH', url: '/leads/1', payload: { status: 'x' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PATCH', url: '/leads/1', payload: { status: 'NEW' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PATCH', url: '/leads/1', payload: { status: 'qualified' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: '1', status: 'QUALIFIED' });

    await app.close();
  });
});
