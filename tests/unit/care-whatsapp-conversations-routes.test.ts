import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import whatsappConversationRoutes from '../../src/modules/care/routes/whatsapp-conversations';
import prisma from '../../src/modules/care/lib/prisma';

const sendTextMessageMock = vi.fn();
const getMediaUrlMock = vi.fn();

vi.mock('../../src/modules/care/lib/gupshup', () => ({
  default: vi.fn().mockImplementation(() => ({
    sendTextMessage: sendTextMessageMock,
    getMediaUrl: getMediaUrlMock,
  })),
}));

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    branch: { findMany: vi.fn() },
    whatsAppConversationOperatorConfig: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
    whatsAppConversationSettings: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
    whatsAppConversation: { groupBy: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), count: vi.fn(), update: vi.fn() },
    whatsAppConversationMessage: { findMany: vi.fn(), create: vi.fn() },
    patient: { findFirst: vi.fn() },
    appointment: { findMany: vi.fn() },
    whatsAppConfig: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

const mockedPrisma = prisma as any;

async function buildApp(opts?: { unauthorized?: boolean; noCompany?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1' };
  });

  mockedPrisma.user.findUnique.mockResolvedValue(
    opts?.noCompany
      ? { id: 'u-1', sector: null }
      : {
          id: 'u-1',
          name: 'Operador',
          email: 'op@test.com',
          sector: { branch: { id: 'b-1', companyId: 'c-1', tradeName: 'Filial A' } },
        },
  );

  await app.register(whatsappConversationRoutes, { prefix: '/wc' });
  return app;
}

describe('care whatsapp-conversations routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockedPrisma.branch.findMany.mockResolvedValue([{ id: 'b-1', tradeName: 'Filial A' }]);
    mockedPrisma.user.findMany.mockResolvedValue([
      { id: 'u-1', name: 'Operador', email: 'op@test.com', sector: { branch: { tradeName: 'Filial A' } } },
    ]);

    mockedPrisma.whatsAppConversationOperatorConfig.findUnique.mockResolvedValue({
      userId: 'u-1',
      isActive: true,
      maxActiveConversations: 3,
      flowKeys: [],
    });
    mockedPrisma.whatsAppConversationOperatorConfig.findMany.mockResolvedValue([]);
    mockedPrisma.whatsAppConversationOperatorConfig.upsert.mockResolvedValue({ userId: 'u-1', isActive: true });

    mockedPrisma.whatsAppConversationSettings.findUnique.mockResolvedValue({ branchId: 'b-1', idleTimeoutMinutes: 25, closeWarningMinutes: 5 });
    mockedPrisma.whatsAppConversationSettings.create.mockResolvedValue({ branchId: 'b-1', idleTimeoutMinutes: 25, closeWarningMinutes: 5 });
    mockedPrisma.whatsAppConversationSettings.upsert.mockResolvedValue({ branchId: 'b-1', idleTimeoutMinutes: 20, closeWarningMinutes: 4 });

    mockedPrisma.whatsAppConversation.groupBy.mockResolvedValue([]);
    mockedPrisma.whatsAppConversation.findMany.mockResolvedValue([{ id: 'conv-1', humanFlowKey: 'F1' }]);
    mockedPrisma.whatsAppConversation.findFirst.mockResolvedValue({
      id: 'conv-1',
      branchId: 'b-1',
      phone: '11999998888',
      patientId: 'p-1',
      humanFlowKey: 'F1',
      humanStatus: 'QUEUED',
      humanAssignedUserId: null,
      humanAssignedUserName: null,
      humanProtocolNumber: 'WA-20260413-AAA',
      humanProtocolClosedAt: null,
    });
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValue(null);
    mockedPrisma.whatsAppConversation.count.mockResolvedValue(0);
    mockedPrisma.whatsAppConversation.update.mockResolvedValue({ id: 'conv-1', humanStatus: 'ASSIGNED' });

    mockedPrisma.whatsAppConversationMessage.findMany.mockResolvedValue([
      { id: 'm-1', message: '[Protocolo WA-20260413-AAA] início', metadata: { protocolNumber: 'WA-20260413-AAA' }, createdAt: new Date('2026-04-10T10:00:00Z') },
      { id: 'm-2', message: 'Atendimento encerrado', metadata: { protocolNumber: 'WA-20260413-AAA' }, createdAt: new Date('2026-04-10T10:05:00Z') },
    ]);
    mockedPrisma.whatsAppConversationMessage.create.mockResolvedValue({ id: 'm-created' });

    mockedPrisma.patient.findFirst.mockResolvedValue({ id: 'p-1', name: 'Maria' });
    mockedPrisma.appointment.findMany.mockResolvedValue([]);

    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValue({
      branchId: 'b-1',
      accountSid: 'api-key',
      authToken: 'app-name',
      fromNumber: '5511999990000',
      isActive: true,
    });

    mockedPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'tpl-1',
        companyId: 'c-1',
        createdByUserId: 'u-1',
        createdByName: 'Operador',
        name: 'Saudação',
        text: 'Olá! 😊\nComo posso ajudar?',
        createdAt: new Date('2026-05-12T10:00:00Z'),
        updatedAt: new Date('2026-05-12T10:00:00Z'),
      },
    ]);
    mockedPrisma.$executeRaw.mockResolvedValue(1);

    sendTextMessageMock.mockResolvedValue({ status: 'success', messageId: 'mid-1' });
    getMediaUrlMock.mockResolvedValue({ url: 'https://cdn/file.jpg' });
  });

  it('lists flows and blocks when scope is missing', async () => {
    const app = await buildApp();
    let res = await app.inject({ method: 'GET', url: '/wc/whatsapp/conversations/flows' });
    expect(res.statusCode).toBe(200);

    const noCompanyApp = await buildApp({ noCompany: true });
    res = await noCompanyApp.inject({ method: 'GET', url: '/wc/whatsapp/conversations/operators' });
    expect(res.statusCode).toBe(403);

    await app.close();
    await noCompanyApp.close();
  });

  it('handles operators and settings endpoints', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/wc/whatsapp/conversations/operators' });
    expect(res.statusCode).toBe(200);

    res = await app.inject({
      method: 'PUT',
      url: '/wc/whatsapp/conversations/settings',
      payload: { idleTimeoutMinutes: 20, closeWarningMinutes: 4 },
    });
    expect(res.statusCode).toBe(200);

    res = await app.inject({
      method: 'PUT',
      url: '/wc/whatsapp/conversations/operators/u-1',
      payload: { isActive: true, maxActiveConversations: 5, flowKeys: ['F1', 'F1'] },
    });
    expect(res.statusCode).toBe(200);

    mockedPrisma.user.findUnique.mockResolvedValueOnce({ id: 'u-1', sector: { branch: { id: 'b-1', companyId: 'c-1' } } })
      .mockResolvedValueOnce({ id: 'u-x', sector: { branch: { companyId: 'other' } } });
    res = await app.inject({ method: 'PUT', url: '/wc/whatsapp/conversations/operators/u-x', payload: {} });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('lists and creates conversation templates for active operators', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/wc/whatsapp/conversations/templates' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].text).toContain('😊');

    res = await app.inject({
      method: 'POST',
      url: '/wc/whatsapp/conversations/templates',
      payload: { name: 'Confirmação', text: 'Linha 1\n\nLinha 3  ' },
    });
    expect(res.statusCode).toBe(201);
    expect(mockedPrisma.$executeRaw).toHaveBeenCalled();

    res = await app.inject({
      method: 'POST',
      url: '/wc/whatsapp/conversations/templates',
      payload: { name: 'Sem texto', text: '   ' },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('guards conversation templates by company scope and active operator', async () => {
    const noCompanyApp = await buildApp({ noCompany: true });
    let res = await noCompanyApp.inject({ method: 'GET', url: '/wc/whatsapp/conversations/templates' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/company/i);
    await noCompanyApp.close();

    mockedPrisma.whatsAppConversationOperatorConfig.findUnique.mockResolvedValueOnce({
      userId: 'u-1',
      isActive: false,
      maxActiveConversations: 3,
      flowKeys: [],
    });

    const inactiveApp = await buildApp();
    res = await inactiveApp.inject({
      method: 'POST',
      url: '/wc/whatsapp/conversations/templates',
      payload: { name: 'Saudação', text: 'Olá' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/operator/i);
    await inactiveApp.close();
  });

  it('validates conversation template payload before persisting', async () => {
    const app = await buildApp();

    let res = await app.inject({
      method: 'POST',
      url: '/wc/whatsapp/conversations/templates',
      payload: { text: 'Texto sem nome' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/name/i);

    res = await app.inject({
      method: 'POST',
      url: '/wc/whatsapp/conversations/templates',
      payload: { name: 'Sem texto', text: null },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/text/i);

    expect(mockedPrisma.$executeRaw).not.toHaveBeenCalled();
    await app.close();
  });

  it('lists conversations and messages/protocol details', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/wc/whatsapp/conversations?status=ALL&mineOnly=false' });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: '/wc/whatsapp/conversations/conv-1/messages' });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: '/wc/whatsapp/conversations/conv-1/protocols/WA-20260413-AAA' });
    expect(res.statusCode).toBe(200);

    mockedPrisma.whatsAppConversation.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/wc/whatsapp/conversations/conv-x/messages' });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('claims conversation and sends greeting', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'POST', url: '/wc/whatsapp/conversations/conv-1/claim' });

    expect(res.statusCode).toBe(200);
    expect(sendTextMessageMock).toHaveBeenCalled();
    expect(mockedPrisma.whatsAppConversationMessage.create).toHaveBeenCalled();

    await app.close();
  });

  it('sends operator message with assignment checks', async () => {
    const app = await buildApp();

    mockedPrisma.whatsAppConversation.findFirst.mockResolvedValueOnce({
      id: 'conv-1',
      branchId: 'b-1',
      phone: '11999998888',
      humanFlowKey: 'F1',
      humanAssignedUserId: 'u-1',
      humanProtocolNumber: 'WA-20260413-AAA',
    });

    let res = await app.inject({
      method: 'POST',
      url: '/wc/whatsapp/conversations/conv-1/messages',
      payload: { message: 'Olá paciente' },
    });
    expect(res.statusCode).toBe(200);

    mockedPrisma.whatsAppConversation.findFirst.mockResolvedValueOnce({
      id: 'conv-1',
      branchId: 'b-1',
      phone: '11999998888',
      humanFlowKey: 'F1',
      humanAssignedUserId: 'other-user',
    });
    res = await app.inject({
      method: 'POST',
      url: '/wc/whatsapp/conversations/conv-1/messages',
      payload: { message: 'Oi' },
    });
    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it('closes conversation and resolves media endpoint branches', async () => {
    const app = await buildApp();

    mockedPrisma.whatsAppConversation.findFirst.mockResolvedValueOnce({
      id: 'conv-1',
      branchId: 'b-1',
      phone: '11999998888',
      humanFlowKey: 'F1',
      humanAssignedUserId: 'u-1',
      humanProtocolNumber: 'WA-20260413-AAA',
    });

    let res = await app.inject({ method: 'POST', url: '/wc/whatsapp/conversations/conv-1/close' });
    expect(res.statusCode).toBe(200);

    await app.close();

    const mediaApp = await buildApp();

    res = await mediaApp.inject({ method: 'GET', url: '/wc/whatsapp/media/m-1' });
    expect(res.statusCode).toBe(200);

    await mediaApp.close();
  });

  it('filters conversations by status/search/mineOnly/flowKey and handles inactive operator', async () => {
    // inactive operator → empty items
    mockedPrisma.whatsAppConversationOperatorConfig.findUnique.mockResolvedValueOnce({
      userId: 'u-1', isActive: false, maxActiveConversations: 3, flowKeys: [],
    });
    const app = await buildApp();
    let res = await app.inject({ method: 'GET', url: '/wc/whatsapp/conversations?status=QUEUED' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);

    // status=CLOSED
    res = await app.inject({ method: 'GET', url: '/wc/whatsapp/conversations?status=CLOSED' });
    expect(res.statusCode).toBe(200);

    // status=INVALID → defaults to ALL
    res = await app.inject({ method: 'GET', url: '/wc/whatsapp/conversations?status=INVALID' });
    expect(res.statusCode).toBe(200);

    // search param → OR conditions
    res = await app.inject({ method: 'GET', url: '/wc/whatsapp/conversations?search=Maria' });
    expect(res.statusCode).toBe(200);

    // mineOnly=true → adds humanAssignedUserId filter
    res = await app.inject({ method: 'GET', url: '/wc/whatsapp/conversations?mineOnly=true' });
    expect(res.statusCode).toBe(200);

    // flowKey param → exact flow filter
    res = await app.inject({ method: 'GET', url: '/wc/whatsapp/conversations?flowKey=F2' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('shows canView=false for conversations outside operator flowKeys restriction', async () => {
    mockedPrisma.whatsAppConversationOperatorConfig.findUnique.mockResolvedValue({
      userId: 'u-1', isActive: true, maxActiveConversations: 3, flowKeys: ['F1'],
    });
    mockedPrisma.whatsAppConversation.findMany.mockResolvedValue([
      { id: 'conv-1', humanFlowKey: 'F1' },  // in allowed list
      { id: 'conv-2', humanFlowKey: 'OTHER' }, // not in allowed list
    ]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/wc/whatsapp/conversations' });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items.find((i: any) => i.id === 'conv-1').canView).toBe(true);
    expect(items.find((i: any) => i.id === 'conv-2').canView).toBe(false);

    // Reset to default for subsequent tests
    mockedPrisma.whatsAppConversationOperatorConfig.findUnique.mockResolvedValue({
      userId: 'u-1', isActive: true, maxActiveConversations: 3, flowKeys: [],
    });
    await app.close();
  });

  it('returns patient details and sorted appointments in GET /messages', async () => {
    mockedPrisma.patient.findFirst.mockResolvedValueOnce({
      id: 'p-1', name: 'Maria', cpf: '12345678901', cellphone: '11999998888',
      phone: null, birthDate: new Date('1990-01-01'), healthInsuranceName: 'Plano X',
      healthInsuranceNumber: '123', email: 'p@m.com', address: null, observations: null,
    });
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([
      { id: 'a-future', date: '2099-12-31', time: '09:00', type: 'CONSULTA', status: 'AGENDADO', doctorName: 'Dr A', specialty: 'USG', convenio: null },
      { id: 'a-past', date: '2000-01-01', time: '09:00', type: 'CONSULTA', status: 'REALIZADO', doctorName: 'Dr A', specialty: 'USG', convenio: null },
    ]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/wc/whatsapp/conversations/conv-1/messages' });
    expect(res.statusCode).toBe(200);
    expect(res.json().patient.name).toBe('Maria');
    expect(res.json().appointments.next.id).toBe('a-future');
    expect(res.json().appointments.recent[0].id).toBe('a-past');
    await app.close();
  });

  it('GET /messages restricts access when operator flowKeys excludes conversation flowKey', async () => {
    mockedPrisma.whatsAppConversationOperatorConfig.findUnique.mockResolvedValue({
      userId: 'u-1', isActive: true, maxActiveConversations: 3, flowKeys: ['OTHER_FLOW'],
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/wc/whatsapp/conversations/conv-1/messages' });
    expect(res.statusCode).toBe(403);

    mockedPrisma.whatsAppConversationOperatorConfig.findUnique.mockResolvedValue({
      userId: 'u-1', isActive: true, maxActiveConversations: 3, flowKeys: [],
    });
    await app.close();
  });

  it('POST /claim rejects CLOSED, same-user, and max-capacity conversations', async () => {
    const app = await buildApp();

    // CLOSED conversation → 400
    mockedPrisma.whatsAppConversation.findFirst.mockResolvedValueOnce({
      id: 'conv-1', branchId: 'b-1', phone: '11999998888', humanFlowKey: 'F1',
      humanStatus: 'CLOSED', humanAssignedUserId: null,
    });
    let res = await app.inject({ method: 'POST', url: '/wc/whatsapp/conversations/conv-1/claim' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/encerrada/i);

    // ASSIGNED to same user → 400
    mockedPrisma.whatsAppConversation.findFirst.mockResolvedValueOnce({
      id: 'conv-1', branchId: 'b-1', phone: '11999998888', humanFlowKey: 'F1',
      humanStatus: 'ASSIGNED', humanAssignedUserId: 'u-1',
    });
    res = await app.inject({ method: 'POST', url: '/wc/whatsapp/conversations/conv-1/claim' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/já está atendendo/i);

    // Max active conversations reached → 400
    mockedPrisma.whatsAppConversation.count.mockResolvedValueOnce(3); // = maxActiveConversations
    res = await app.inject({ method: 'POST', url: '/wc/whatsapp/conversations/conv-1/claim' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/limit/i);

    await app.close();
  });

  it('POST /claim succeeds with takeover (ASSIGNED different user) and sends transfer message', async () => {
    mockedPrisma.whatsAppConversation.findFirst.mockResolvedValueOnce({
      id: 'conv-1', branchId: 'b-1', phone: '11999998888', humanFlowKey: 'F1',
      humanStatus: 'ASSIGNED', humanAssignedUserId: 'other-user',
      humanAssignedUserName: 'Outro Operador', humanProtocolNumber: 'WA-20260413-AAA',
      humanProtocolClosedAt: null,
    });
    mockedPrisma.whatsAppConversation.count.mockResolvedValueOnce(0);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/wc/whatsapp/conversations/conv-1/claim' });
    expect(res.statusCode).toBe(200);
    // Transfer message should be sent (not greeting)
    expect(sendTextMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('seguirá com você') }),
    );
    await app.close();
  });

  it('POST /close rejects when conversation is assigned to a different user', async () => {
    mockedPrisma.whatsAppConversation.findFirst.mockResolvedValueOnce({
      id: 'conv-1', branchId: 'b-1', phone: '11999998888', humanFlowKey: 'F1',
      humanAssignedUserId: 'other-user', humanProtocolNumber: 'WA-20260413-AAA',
    });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/wc/whatsapp/conversations/conv-1/close' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('POST /close succeeds when conversation has no assigned user (unassigned)', async () => {
    mockedPrisma.whatsAppConversation.findFirst.mockResolvedValueOnce({
      id: 'conv-1', branchId: 'b-1', phone: '11999998888', humanFlowKey: 'F1',
      humanAssignedUserId: null, humanProtocolNumber: 'WA-20260413-AAA',
    });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/wc/whatsapp/conversations/conv-1/close' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('GET /media returns 404 when URL not found and 503 when config missing', async () => {
    const app = await buildApp();

    // url is null → 404
    getMediaUrlMock.mockResolvedValueOnce({ url: null });
    let res = await app.inject({ method: 'GET', url: '/wc/whatsapp/media/m-1' });
    expect(res.statusCode).toBe(404);

    // no config (whatsAppConfig not active) → 503
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ branchId: 'b-1', isActive: false });
    res = await app.inject({ method: 'GET', url: '/wc/whatsapp/media/m-1' });
    expect(res.statusCode).toBe(503);

    // successful case → 200 with url
    getMediaUrlMock.mockResolvedValueOnce({ url: 'https://cdn/file.jpg' });
    res = await app.inject({ method: 'GET', url: '/wc/whatsapp/media/m-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toBe('https://cdn/file.jpg');

    await app.close();
  });
});
