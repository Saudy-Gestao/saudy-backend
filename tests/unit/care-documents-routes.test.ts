import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import documentRoutes from '../../src/modules/care/routes/documents';
import prisma from '../../src/modules/care/lib/prisma';

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    document: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
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

  await app.register(documentRoutes, { prefix: '/documents' });
  return app;
}

describe('care documents routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b-1' } } });
  });

  it('returns 401 when jwt fails', async () => {
    const app = await buildApp({ unauthorized: true });
    const res = await app.inject({ method: 'GET', url: '/documents' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('lists documents with branch filter', async () => {
    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    mockedPrisma.document.findMany.mockResolvedValue([{ id: 'd-1' }]);
    mockedPrisma.document.count.mockResolvedValue(1);

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/documents' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/documents?search=maria&status=OPEN&documentType=EXAME' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [{ id: 'd-1' }], total: 1 });

    await app.close();
  });

  it('gets document by id and handles missing', async () => {
    mockedPrisma.document.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'd-1' });

    const app = await buildApp();
    let res = await app.inject({ method: 'GET', url: '/documents/d-1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/documents/d-1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('creates and updates documents with error handling', async () => {
    mockedPrisma.document.create.mockRejectedValueOnce(new Error('bad create')).mockResolvedValueOnce({ id: 'd-1' });
    mockedPrisma.document.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'd-1' });
    mockedPrisma.document.update.mockRejectedValueOnce(new Error('bad update')).mockResolvedValueOnce({ id: 'd-1' });

    const app = await buildApp();

    let res = await app.inject({
      method: 'POST',
      url: '/documents',
      payload: { documentType: 'EXAME', description: 'x' },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/documents',
      payload: { documentType: 'EXAME', description: 'x' },
    });
    expect(res.statusCode).toBe(201);

    res = await app.inject({ method: 'PUT', url: '/documents/d-1', payload: { description: 'y' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/documents/d-1', payload: { description: 'y' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.document.findFirst.mockResolvedValueOnce({ id: 'd-1' });
    res = await app.inject({ method: 'PUT', url: '/documents/d-1', payload: { description: 'z' } });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('deletes document and handles not found', async () => {
    mockedPrisma.document.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'd-1' });
    mockedPrisma.document.delete.mockResolvedValue({});

    const app = await buildApp();

    let res = await app.inject({ method: 'DELETE', url: '/documents/d-1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/documents/d-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'Deleted' });

    await app.close();
  });
});
