import { Readable } from 'stream';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ticketRoutes from '../../src/modules/admin/routes/tickets';
import prisma from '../../src/modules/admin/lib/prisma';
import { getAnexosStorage } from '../../src/lib/storage';

vi.mock('../../src/modules/admin/lib/prisma', () => ({
  default: {
    ticket: {
      updateMany: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    ticketMessage: {
      findMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    adminUser: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../src/lib/storage', () => ({
  getAnexosStorage: vi.fn(),
}));

const mockedPrisma = prisma as any;
const mockedGetAnexosStorage = getAnexosStorage as any;

async function buildApp(userOverride?: { id: string; admHubOnly: boolean }) {
  const app = Fastify();
  app.decorateRequest('jwtVerify', async function jwtVerify() {});
  app.decorateRequest('user', null);

  app.addHook('preHandler', async (request) => {
    (request as any).user = userOverride ?? { id: 'u-1', admHubOnly: false };
  });

  app.addSchema({ $id: 'Ticket', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'TicketStatusUpdate', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'TicketPriorityUpdate', type: 'object', additionalProperties: true });

  await app.register(ticketRoutes, { prefix: '/tickets' });
  return app;
}

describe('admin tickets routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.ticket.updateMany.mockResolvedValue({ count: 0 });
    mockedGetAnexosStorage.mockReturnValue({
      save: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockResolvedValue(true),
      createReadStream: vi.fn().mockReturnValue(Readable.from(['ok'])),
    });
  });

  it('lists tickets with filters and unread flag', async () => {
    mockedPrisma.ticket.findMany.mockResolvedValue([
      { id: '1', lastUserMessageAt: new Date('2026-01-01T12:00:00Z'), lastReadByAdminAt: null },
      { id: '2', lastUserMessageAt: null, lastReadByAdminAt: null },
    ]);
    mockedPrisma.ticket.count.mockResolvedValue(2);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/tickets?search=bot&status=OPEN&type=BUG&priority=HIGH&sort=PRIORITY_LOW&limit=10&offset=2' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.items[0].hasUnreadUserMessage).toBe(true);
    expect(body.items[1].hasUnreadUserMessage).toBe(false);
    expect(mockedPrisma.ticket.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 10,
      skip: 2,
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    }));

    await app.close();
  });

  it('updates status with validation, missing and resolved transition', async () => {
    mockedPrisma.ticket.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 't1', status: 'OPEN', resolutionConfirmationDeadlineAt: null, resolutionConfirmedAt: null })
      .mockResolvedValueOnce({ id: 't1', status: 'RESOLVED', resolutionConfirmationDeadlineAt: new Date(), resolutionConfirmedAt: new Date() });

    mockedPrisma.$transaction.mockResolvedValue([{ id: 't1', status: 'RESOLVED' }]);
    mockedPrisma.ticket.update.mockResolvedValue({ id: 't1', status: 'CLOSED' });

    const app = await buildApp();

    let res = await app.inject({ method: 'PATCH', url: '/tickets/t1/status', payload: { status: '???' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PATCH', url: '/tickets/t1/status', payload: { status: 'OPEN' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PATCH', url: '/tickets/t1/status', payload: { status: 'RESOLVED' } });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.$transaction).toHaveBeenCalled();

    res = await app.inject({ method: 'PATCH', url: '/tickets/t1/status', payload: { status: 'CLOSED' } });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.ticket.update).toHaveBeenCalled();

    await app.close();
  });

  it('updates priority with validation and not found', async () => {
    mockedPrisma.ticket.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 't1' });
    mockedPrisma.ticket.update.mockResolvedValue({ id: 't1', priority: 'HIGH' });

    const app = await buildApp();

    let res = await app.inject({ method: 'PATCH', url: '/tickets/t1/priority', payload: { priority: 'x' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PATCH', url: '/tickets/t1/priority', payload: { priority: 'HIGH' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PATCH', url: '/tickets/t1/priority', payload: { priority: 'LOW' } });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('gets ticket by id and messages list', async () => {
    mockedPrisma.ticket.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 't1', lastUserMessageAt: new Date('2026-01-01T12:00:00Z'), lastReadByAdminAt: null })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 't1' });
    mockedPrisma.ticketMessage.findMany.mockResolvedValue([{ id: 'm1' }]);
    mockedPrisma.ticket.update.mockResolvedValue({ id: 't1' });

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/tickets/t1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/tickets/t1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().hasUnreadUserMessage).toBe(true);

    res = await app.inject({ method: 'GET', url: '/tickets/t1/messages' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/tickets/t1/messages' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [{ id: 'm1' }] });

    await app.close();
  });

  it('validates message creation inputs and closed ticket', async () => {
    mockedPrisma.ticket.findUnique.mockResolvedValueOnce({ id: 't1', status: 'CLOSED' });

    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/tickets/t1/messages', payload: { message: '   ' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/tickets/t1/messages',
      payload: { message: 'ok', attachment: { name: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10, base64: 'x' } },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/tickets/no/messages', payload: { message: 'ok' } });
    expect(res.statusCode).toBe(409);

    await app.close();
  });

  it('creates admin message with attachment and admHubOnly actor', async () => {
    mockedPrisma.ticket.findUnique.mockResolvedValue({ id: 't1', branchId: 'b1', status: 'OPEN' });
    mockedPrisma.adminUser.findUnique.mockResolvedValue({ id: 'u-1', name: 'Admin Hub', email: 'admin@hub.com' });
    mockedPrisma.ticketMessage.create.mockResolvedValue({ id: 'm1' });
    mockedPrisma.ticket.update.mockResolvedValue({ id: 't1' });

    const app = await buildApp({ id: 'u-1', admHubOnly: true });

    const payload = {
      message: '  resposta  ',
      attachment: {
        name: 'laudo final?.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 3,
        base64: 'data:application/pdf;base64,YWJj',
      },
    };

    const res = await app.inject({ method: 'POST', url: '/tickets/t1/messages', payload });

    expect(res.statusCode).toBe(201);
    expect(mockedGetAnexosStorage().save).toHaveBeenCalled();
    expect(mockedPrisma.ticketMessage.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        authorName: 'Admin Hub',
        authorEmail: 'admin@hub.com',
        message: 'resposta',
        attachmentName: expect.stringContaining('laudo_final_.pdf'),
      }),
    }));

    await app.close();
  });

  it('returns 404 on attachment view for missing message/file', async () => {
    const storage = mockedGetAnexosStorage();
    mockedPrisma.ticketMessage.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'm1', ticket: { id: 't1' }, attachmentObjectName: null })
      .mockResolvedValueOnce({ id: 'm2', ticket: { id: 't1' }, attachmentObjectName: 'obj', attachmentMimeType: 'application/pdf', attachmentName: 'a.pdf' });
    storage.exists.mockResolvedValue(false);

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/tickets/messages/m0/attachment/view' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/tickets/messages/m1/attachment/view' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/tickets/messages/m2/attachment/view' });
    expect(res.statusCode).toBe(404);

    await app.close();
  });
});
