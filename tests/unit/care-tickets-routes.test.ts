import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ticketRoutes from '../../src/modules/care/routes/tickets';
import prisma from '../../src/modules/care/lib/prisma';
import { getAnexosStorage } from '../../src/lib/storage';

vi.mock('../../src/lib/storage', () => ({
  getAnexosStorage: vi.fn(),
}));

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    ticket: {
      updateMany: vi.fn(),
      create: vi.fn(),
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
  },
}));

const mockedPrisma = prisma as any;
const mockedGetAnexosStorage = getAnexosStorage as any;

const storageMock = {
  save: vi.fn(),
  exists: vi.fn(),
  createReadStream: vi.fn(() => 'stream'),
};

async function buildApp(opts?: { unauthorized?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1' };
  });

  await app.register(ticketRoutes, { prefix: '/tickets' });
  return app;
}

describe('care tickets routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedGetAnexosStorage.mockReturnValue(storageMock);

    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 'u-1',
      name: 'User',
      email: 'user@test.com',
      sector: { branch: { id: 'b-1', tradeName: 'Branch' } },
    });
    mockedPrisma.ticket.updateMany.mockResolvedValue({ count: 0 });
    mockedPrisma.ticket.create.mockResolvedValue({
      id: 't-1',
      createdByUserId: 'u-1',
      status: 'OPEN',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    mockedPrisma.ticket.findMany.mockResolvedValue([{ id: 't-1', lastAdminMessageAt: null, lastReadByUserAt: null }]);
    mockedPrisma.ticket.count.mockResolvedValue(1);
    mockedPrisma.ticket.findUnique.mockResolvedValue({ id: 't-1', createdByUserId: 'u-1', status: 'OPEN', branchId: 'b-1' });
    mockedPrisma.ticket.update.mockResolvedValue({ id: 't-1', status: 'CLOSED' });

    mockedPrisma.ticketMessage.findMany.mockResolvedValue([{ id: 'm-1' }]);
    mockedPrisma.ticketMessage.create.mockResolvedValue({ id: 'm-1' });
    mockedPrisma.ticketMessage.findUnique.mockResolvedValue({
      id: 'm-1',
      attachmentObjectName: 'obj',
      attachmentName: 'file.txt',
      attachmentMimeType: 'text/plain',
      ticket: { createdByUserId: 'u-1' },
    });

    storageMock.save.mockResolvedValue(undefined);
    storageMock.exists.mockResolvedValue(true);
  });

  it('enforces auth and validates ticket creation', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'POST', url: '/tickets', payload: {} });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    const app = await buildApp();
    // Passes schema but fails route-level validation (description < 10)
    res = await app.inject({
      method: 'POST',
      url: '/tickets',
      payload: { flow: 'Fluxo', module: 'Modulo', type: 'BUG', description: 'curta' },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/tickets', payload: { flow: '', module: '', type: 'x', description: 'abc' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/tickets',
      payload: { flow: 'Fluxo', module: 'Módulo', type: 'BUG', description: 'Descrição válida 123' },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('creates ticket without user id and falls back to branch name when tradeName is absent', async () => {
    const appNoId = Fastify();
    appNoId.decorateRequest('user', null);
    appNoId.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
      this.user = {};
    });
    await appNoId.register(ticketRoutes, { prefix: '/tickets' });

    let res = await appNoId.inject({
      method: 'POST',
      url: '/tickets',
      payload: { flow: 'Fluxo', module: 'Modulo', type: 'BUG', description: 'Descrição válida sem usuário' },
    });
    expect(res.statusCode).toBe(201);
    expect(mockedPrisma.user.findUnique).not.toHaveBeenCalled();

    await appNoId.close();

    const app = await buildApp();
    mockedPrisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-1',
      name: 'User',
      email: 'user@test.com',
      sector: { branch: { id: 'b-1', tradeName: '', name: 'Branch Name Fallback' } },
    });

    res = await app.inject({
      method: 'POST',
      url: '/tickets',
      payload: { flow: 'Fluxo', module: 'Modulo', type: 'BUG', description: 'Descrição válida com branch fallback' },
    });
    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it('creates ticket with null creator metadata when user lookup returns null', async () => {
    const app = await buildApp();
    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'POST',
      url: '/tickets',
      payload: {
        flow: 'Fluxo',
        module: 'Modulo',
        type: 'BUG',
        description: 'Descricao valida sem usuario encontrado',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockedPrisma.ticket.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        createdByUserId: 'u-1',
        createdByName: null,
        createdByEmail: null,
        branchId: null,
        branchName: null,
      }),
    }));

    await app.close();
  });

  it('lists mine/get/messages and marks read', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/tickets/mine?status=ALL&type=ALL&search=x' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    mockedPrisma.ticket.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/tickets/t-1' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.ticket.findUnique.mockResolvedValueOnce({ id: 't-1', createdByUserId: 'other' });
    res = await app.inject({ method: 'GET', url: '/tickets/t-1' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/tickets/t-1' });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: '/tickets/t-1/messages' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('creates ticket messages and validates attachment/closed ticket', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/tickets/t-1/messages', payload: { message: ' ' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/tickets/t-1/messages',
      payload: { message: 'ok', attachment: { name: 'x', mimeType: 'text/plain', sizeBytes: 10, base64: 'invalid' } },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.ticket.findUnique.mockResolvedValueOnce({ id: 't-1', createdByUserId: 'u-1', status: 'CLOSED' });
    res = await app.inject({ method: 'POST', url: '/tickets/t-1/messages', payload: { message: 'mensagem válida' } });
    expect(res.statusCode).toBe(409);

    res = await app.inject({
      method: 'POST',
      url: '/tickets/t-1/messages',
      payload: {
        message: 'mensagem válida',
        attachment: {
          name: 'a.txt',
          mimeType: 'text/plain',
          sizeBytes: 10,
          base64: 'data:text/plain;base64,YQ==',
        },
      },
    });
    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it('confirms close and views attachment', async () => {
    const app = await buildApp();

    mockedPrisma.ticket.findUnique.mockResolvedValueOnce({ id: 't-1', createdByUserId: 'u-1', status: 'OPEN' });
    let res = await app.inject({ method: 'POST', url: '/tickets/t-1/confirm-close' });
    expect(res.statusCode).toBe(400);

    mockedPrisma.ticket.findUnique.mockResolvedValueOnce({ id: 't-1', createdByUserId: 'u-1', status: 'RESOLVED' });
    res = await app.inject({ method: 'POST', url: '/tickets/t-1/confirm-close' });
    expect(res.statusCode).toBe(200);

    mockedPrisma.ticketMessage.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/tickets/messages/m-1/attachment/view' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.ticketMessage.findUnique.mockResolvedValueOnce({
      id: 'm-1',
      attachmentObjectName: 'obj',
      ticket: { createdByUserId: 'other' },
    });
    res = await app.inject({ method: 'GET', url: '/tickets/messages/m-1/attachment/view' });
    expect(res.statusCode).toBe(403);

    mockedPrisma.ticketMessage.findUnique.mockResolvedValueOnce({
      id: 'm-1',
      attachmentObjectName: null,
      ticket: { createdByUserId: 'u-1' },
    });
    res = await app.inject({ method: 'GET', url: '/tickets/messages/m-1/attachment/view' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.ticketMessage.findUnique.mockResolvedValueOnce({
      id: 'm-1',
      attachmentObjectName: 'obj',
      attachmentName: 'a.txt',
      attachmentMimeType: 'text/plain',
      ticket: { createdByUserId: 'u-1' },
    });
    storageMock.exists.mockResolvedValueOnce(false);
    res = await app.inject({ method: 'GET', url: '/tickets/messages/m-1/attachment/view' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/tickets/messages/m-1/attachment/view' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('covers hasUnreadAdminMessage branch and buffer overflow in attachment', async () => {
    const app = await buildApp();

    // hasUnreadAdminMessage = true when lastAdminMessageAt > lastReadByUserAt
    mockedPrisma.ticket.findMany.mockResolvedValueOnce([{
      id: 't-1',
      lastAdminMessageAt: new Date('2026-04-14T10:00:00Z'),
      lastReadByUserAt: new Date('2026-04-10T10:00:00Z'),
    }]);
    let res = await app.inject({ method: 'GET', url: '/tickets/mine?status=ALL&type=ALL' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    // hasUnreadAdminMessage = false when lastReadByUserAt > lastAdminMessageAt (also tests status/type filters)
    mockedPrisma.ticket.findMany.mockResolvedValueOnce([{
      id: 't-1',
      lastAdminMessageAt: new Date('2026-04-10T10:00:00Z'),
      lastReadByUserAt: new Date('2026-04-14T10:00:00Z'),
    }]);
    res = await app.inject({ method: 'GET', url: '/tickets/mine?status=OPEN&type=BUG' });
    expect(res.statusCode).toBe(200);

    // attachment with sizeBytes > maxAttachmentBytes (5MB) → 400
    res = await app.inject({
      method: 'POST',
      url: '/tickets/t-1/messages',
      payload: {
        message: 'ok',
        attachment: { name: 'big.bin', mimeType: 'application/octet-stream', sizeBytes: 6 * 1024 * 1024, base64: 'data:application/octet-stream;base64,YQ==' },
      },
    });
    expect(res.statusCode).toBe(400);

    // GET /:id with readByUser marks read
    mockedPrisma.ticket.findUnique.mockResolvedValueOnce({ id: 't-1', createdByUserId: 'other-user', status: 'OPEN' });
    res = await app.inject({ method: 'GET', url: '/tickets/t-1' });
    expect(res.statusCode).toBe(403);

    // GET /:id hasUnreadAdminMessage branch when lastReadByUserAt is null
    mockedPrisma.ticket.findUnique.mockResolvedValueOnce({
      id: 't-1',
      createdByUserId: 'u-1',
      status: 'OPEN',
      lastAdminMessageAt: new Date('2026-04-14T10:00:00Z'),
      lastReadByUserAt: null,
    });
    res = await app.inject({ method: 'GET', url: '/tickets/t-1' });
    expect(res.statusCode).toBe(200);

    // attachment with empty decoded buffer -> validation branch inside route
    res = await app.inject({
      method: 'POST',
      url: '/tickets/t-1/messages',
      payload: {
        message: 'ok',
        attachment: {
          name: 'empty.txt',
          mimeType: 'text/plain',
          sizeBytes: 0,
          base64: 'data:text/plain;base64,',
        },
      },
    });
    expect(res.statusCode).toBe(400);

    // malformed base64 can decode to empty buffer and must be rejected in route-level guard
    res = await app.inject({
      method: 'POST',
      url: '/tickets/t-1/messages',
      payload: {
        message: 'ok',
        attachment: {
          name: 'broken.txt',
          mimeType: 'text/plain',
          sizeBytes: 10,
          base64: 'data:text/plain;base64,%%%%',
        },
      },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('covers no-userId 401 and attachment header fallbacks', async () => {
    // user has no id → userId='' → !userId → 401
    const appNoId = Fastify();
    appNoId.decorateRequest('user', null);
    appNoId.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
      this.user = {}; // no id property
    });
    await appNoId.register(ticketRoutes, { prefix: '/tickets' });
    const noIdRes = await appNoId.inject({ method: 'GET', url: '/tickets/messages/m-1/attachment/view' });
    expect(noIdRes.statusCode).toBe(401);
    const noIdGetTicket = await appNoId.inject({ method: 'GET', url: '/tickets/t-1' });
    expect(noIdGetTicket.statusCode).toBe(401);
    const noIdListMessages = await appNoId.inject({ method: 'GET', url: '/tickets/t-1/messages' });
    expect(noIdListMessages.statusCode).toBe(401);
    const noIdMessage = await appNoId.inject({ method: 'POST', url: '/tickets/t-1/messages', payload: { message: 'oi' } });
    expect(noIdMessage.statusCode).toBe(401);
    const confirmNoId = await appNoId.inject({ method: 'POST', url: '/tickets/t-1/confirm-close' });
    expect(confirmNoId.statusCode).toBe(401);
    await appNoId.close();

    // attachmentMimeType and attachmentName are null → fallback 'application/octet-stream' and 'anexo'
    const app = await buildApp();
      // confirm-close: ticket not found → 404
      mockedPrisma.ticket.findUnique.mockResolvedValueOnce(null);
      let res2 = await app.inject({ method: 'POST', url: '/tickets/t-1/confirm-close' });
      expect(res2.statusCode).toBe(404);
      // confirm-close: wrong user → 403
      mockedPrisma.ticket.findUnique.mockResolvedValueOnce({ id: 't-1', createdByUserId: 'other', status: 'RESOLVED' });
      res2 = await app.inject({ method: 'POST', url: '/tickets/t-1/confirm-close' });
      expect(res2.statusCode).toBe(403);
      // GET /:id with lastReadByUserAt newer than lastAdminMessageAt -> hasUnreadAdminMessage=false comparison branch
      mockedPrisma.ticket.findUnique.mockResolvedValueOnce({
        id: 't-1',
        createdByUserId: 'u-1',
        status: 'OPEN',
        lastAdminMessageAt: new Date('2026-04-10T10:00:00Z'),
        lastReadByUserAt: new Date('2026-04-14T10:00:00Z'),
      });
      res2 = await app.inject({ method: 'GET', url: '/tickets/t-1' });
      expect(res2.statusCode).toBe(200);
      // list messages: ticket not found -> 404
      mockedPrisma.ticket.findUnique.mockResolvedValueOnce(null);
      res2 = await app.inject({ method: 'GET', url: '/tickets/t-1/messages' });
      expect(res2.statusCode).toBe(404);
      // list messages: ticket belongs to another user -> 403
      mockedPrisma.ticket.findUnique.mockResolvedValueOnce({ id: 't-1', createdByUserId: 'other', status: 'OPEN' });
      res2 = await app.inject({ method: 'GET', url: '/tickets/t-1/messages' });
      expect(res2.statusCode).toBe(403);
      // messages: ticket not found -> 404
      mockedPrisma.ticket.findUnique.mockResolvedValueOnce(null);
      res2 = await app.inject({ method: 'POST', url: '/tickets/t-1/messages', payload: { message: 'ticket ausente' } });
      expect(res2.statusCode).toBe(404);
      // messages: ticket belongs to another user -> 403
      mockedPrisma.ticket.findUnique.mockResolvedValueOnce({ id: 't-1', createdByUserId: 'other', status: 'OPEN' });
      res2 = await app.inject({ method: 'POST', url: '/tickets/t-1/messages', payload: { message: 'ticket de outro' } });
      expect(res2.statusCode).toBe(403);
      // message without attachment (no attachment) → reaches create with null attachmentPayload → 201
      res2 = await app.inject({ method: 'POST', url: '/tickets/t-1/messages', payload: { message: 'mensagem sem anexo' } });
      expect(res2.statusCode).toBe(201);
      // user with null name/email → covers user?.name || null and user?.email || null
      mockedPrisma.user.findUnique.mockResolvedValueOnce({ id: 'u-1', name: null, email: null, sector: { branch: { id: 'b-1', tradeName: 'Branch' } } });
      res2 = await app.inject({ method: 'POST', url: '/tickets/t-1/messages', payload: { message: 'outro sem nome' } });
      expect(res2.statusCode).toBe(201);
      // ticket.branchId = null → covers 'no-branch' fallback in objectName
      mockedPrisma.ticket.findUnique.mockResolvedValueOnce({ id: 't-1', createdByUserId: 'u-1', status: 'OPEN', branchId: null });
      res2 = await app.inject({
        method: 'POST',
        url: '/tickets/t-1/messages',
        payload: { message: 'branchId nulo', attachment: { name: 'a.txt', mimeType: 'text/plain', sizeBytes: 1, base64: 'data:text/plain;base64,YQ==' } },
      });
      expect(res2.statusCode).toBe(201);
    mockedGetAnexosStorage.mockReturnValue(storageMock);
    mockedPrisma.ticketMessage.findUnique.mockResolvedValueOnce({
      id: 'm-1',
      attachmentObjectName: 'obj',
      attachmentName: null,
      attachmentMimeType: null,
      ticket: { createdByUserId: 'u-1' },
    });
    storageMock.exists.mockResolvedValueOnce(true);
    const res = await app.inject({ method: 'GET', url: '/tickets/messages/m-1/attachment/view' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect(res.headers['content-disposition']).toContain('anexo');
    await app.close();
  });

  it('returns empty mine for user without id and lists mine with default pagination', async () => {
    const appNoId = Fastify();
    appNoId.decorateRequest('user', null);
    appNoId.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
      this.user = {};
    });
    await appNoId.register(ticketRoutes, { prefix: '/tickets' });

    let res = await appNoId.inject({ method: 'GET', url: '/tickets/mine' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], total: 0, limit: 50, offset: 0 });
    await appNoId.close();

    const app = await buildApp();
    res = await app.inject({ method: 'GET', url: '/tickets/mine' });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.ticket.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 50,
      skip: 0,
      where: { createdByUserId: 'u-1' },
    }));
    await app.close();
  });

  it('falls back to default pagination when query numbers are non-finite', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/tickets/mine?limit=Infinity&offset=Infinity',
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.ticket.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 50,
      skip: 0,
    }));

    await app.close();
  });
});
