import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import whatsappMessagesRoutes from '../../src/modules/care/routes/whatsapp-messages';
import prisma from '../../src/modules/care/lib/prisma';
import WhatsAppMessageBuilder from '../../src/modules/care/lib/whatsapp-message-builder';

const sendTemplateMessageMock = vi.fn();
const sendQuickReplyMessageMock = vi.fn();
const sendTextMessageMock = vi.fn();

vi.mock('../../src/modules/care/lib/gupshup', () => ({
  default: vi.fn().mockImplementation(() => ({
    sendTemplateMessage: sendTemplateMessageMock,
    sendQuickReplyMessage: sendQuickReplyMessageMock,
    sendTextMessage: sendTextMessageMock,
  })),
}));

vi.mock('../../src/modules/care/lib/whatsapp-message-builder', () => ({
  default: {
    buildMessage: vi.fn(() => 'mensagem montada'),
    extractTemplateParams: vi.fn(() => ['Maria', '18/03/2026']),
  },
}));

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    appointment: { findFirst: vi.fn() },
    patient: { findUnique: vi.fn() },
    branch: { findUnique: vi.fn() },
    whatsAppConfig: { findUnique: vi.fn() },
    whatsAppMessageTemplate: { findFirst: vi.fn() },
    whatsAppMessageLog: { create: vi.fn(), update: vi.fn(), findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
  },
}));

const mockedPrisma = prisma as any;
const mockedBuilder = WhatsAppMessageBuilder as any;

async function buildApp(opts?: { unauthorized?: boolean; noBranch?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1' };
  });

  mockedPrisma.user.findUnique.mockResolvedValue(
    opts?.noBranch ? { id: 'u-1', sector: null } : { id: 'u-1', sector: { branch: { id: 'b-1' } } },
  );

  await app.register(whatsappMessagesRoutes, { prefix: '/wm' });
  return app;
}

describe('care whatsapp-messages routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockedPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', sector: { branch: { id: 'b-1' } } });
    mockedPrisma.appointment.findFirst.mockResolvedValue({
      id: 'a-1',
      branchId: 'b-1',
      patientId: 'p-1',
      patientName: 'Maria',
      patientCpf: '123',
      doctorName: 'Dr A',
      specialty: 'Cardio',
      date: '2026-04-13',
      time: '10:00',
      convenio: 'X',
      observations: 'obs',
    });
    mockedPrisma.patient.findUnique.mockResolvedValue({ cellphone: '5511999998888' });
    mockedPrisma.branch.findUnique.mockResolvedValue({ tradeName: 'Saudy', address: 'Rua 1' });
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValue({
      branchId: 'b-1',
      accountSid: 'api-key',
      authToken: 'app-name',
      fromNumber: '5511999990000',
      isActive: true,
    });
    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValue({
      id: 'tpl-1',
      message: 'Olá {{paciente_nome}}',
      hsmTemplateId: 'hsm-1',
      hsmTemplateName: 'hsm_name',
      isActive: true,
    });
    mockedPrisma.whatsAppMessageLog.create.mockResolvedValue({ id: 'log-1' });
    mockedPrisma.whatsAppMessageLog.update.mockResolvedValue({ id: 'log-1' });
    mockedPrisma.whatsAppMessageLog.findMany.mockResolvedValue([{ id: 'log-1' }]);
    mockedPrisma.whatsAppMessageLog.count.mockResolvedValue(1);
    mockedPrisma.whatsAppMessageLog.findFirst.mockResolvedValue({ id: 'log-1', branchId: 'b-1' });

    mockedBuilder.buildMessage.mockReturnValue('mensagem montada');
    mockedBuilder.extractTemplateParams.mockReturnValue(['Maria', '18/03/2026']);

    sendTemplateMessageMock.mockResolvedValue({ status: 'success', messageId: 'mid-hsm' });
    sendQuickReplyMessageMock.mockResolvedValue({ status: 'success', messageId: 'mid-quick' });
    sendTextMessageMock.mockResolvedValue({ status: 'success', messageId: 'mid-text' });
  });

  it('enforces auth and branch guard', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({
      method: 'POST',
      url: '/wm/whatsapp/send',
      payload: { appointmentId: 'a-1', messageType: 'APPOINTMENT_CREATED' },
    });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    const app = await buildApp({ noBranch: true });
    res = await app.inject({ method: 'GET', url: '/wm/whatsapp/logs' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('handles send route unhappy paths and catch block', async () => {
    const app = await buildApp();

    mockedPrisma.appointment.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({
      method: 'POST',
      url: '/wm/whatsapp/send',
      payload: { appointmentId: 'x', messageType: 'APPOINTMENT_CREATED' },
    });
    expect(res.statusCode).toBe(404);

    mockedPrisma.patient.findUnique.mockResolvedValueOnce({ cellphone: '' });
    res = await app.inject({
      method: 'POST',
      url: '/wm/whatsapp/send',
      payload: { appointmentId: 'a-1', messageType: 'APPOINTMENT_CREATED' },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({
      method: 'POST',
      url: '/wm/whatsapp/send',
      payload: { appointmentId: 'a-1', messageType: 'APPOINTMENT_CREATED' },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.whatsAppConfig.findUnique.mockRejectedValueOnce(new Error('db-fail'));
    res = await app.inject({
      method: 'POST',
      url: '/wm/whatsapp/send',
      payload: { appointmentId: 'a-1', messageType: 'APPOINTMENT_CREATED' },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('sends with template hsm success and updates log as SENT', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/wm/whatsapp/send',
      payload: { appointmentId: 'a-1', messageType: 'APPOINTMENT_CONFIRMATION' },
    });

    expect(res.statusCode).toBe(200);
    expect(sendTemplateMessageMock).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.whatsAppMessageLog.update).toHaveBeenCalled();

    await app.close();
  });

  it('falls back to quick reply and text when provider returns errors', async () => {
    const app = await buildApp();

    sendTemplateMessageMock.mockResolvedValueOnce({ status: 'error', error: 'hsm-fail' });
    sendQuickReplyMessageMock.mockResolvedValueOnce({ status: 'error', error: 'quick-fail' });
    sendTextMessageMock.mockResolvedValueOnce({ status: 'error', error: 'text-fail' });

    const res = await app.inject({
      method: 'POST',
      url: '/wm/whatsapp/send',
      payload: { appointmentId: 'a-1', messageType: 'APPOINTMENT_CONFIRMATION' },
    });

    expect(res.statusCode).toBe(400);
    expect(sendTemplateMessageMock).toHaveBeenCalledTimes(1);
    expect(sendQuickReplyMessageMock).toHaveBeenCalledTimes(1);
    expect(sendTextMessageMock).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('supports custom message path and successful text send', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/wm/whatsapp/send',
      payload: {
        appointmentId: 'a-1',
        messageType: 'APPOINTMENT_CREATED',
        customMessage: 'msg manual',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(sendTemplateMessageMock).toHaveBeenCalledTimes(0);
    expect(sendTextMessageMock).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('lists logs and gets log by id with 404 path', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/wm/whatsapp/logs?status=SENT&limit=10&offset=0' });
    expect(res.statusCode).toBe(200);

    mockedPrisma.whatsAppMessageLog.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/wm/whatsapp/logs/log-x' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/wm/whatsapp/logs/log-1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('handles test route success and error hints', async () => {
    const app = await buildApp();

    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({
      accountSid: '',
      authToken: '',
      fromNumber: '',
      isActive: true,
    });
    let res = await app.inject({
      method: 'POST',
      url: '/wm/whatsapp/test',
      payload: { phone: '5511', message: 'oi' },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({
      accountSid: 'api-key',
      authToken: 'app-name',
      fromNumber: '5511999990000',
      isActive: false,
    });
    res = await app.inject({
      method: 'POST',
      url: '/wm/whatsapp/test',
      payload: { phone: '5511', message: 'oi' },
    });
    expect(res.statusCode).toBe(400);

    sendTextMessageMock.mockResolvedValueOnce({ status: 'error', error: '401 unauthorized' });
    res = await app.inject({
      method: 'POST',
      url: '/wm/whatsapp/test',
      payload: { phone: '5511', message: 'oi' },
    });
    expect(res.statusCode).toBe(400);

    sendTextMessageMock.mockResolvedValueOnce({ status: 'success', messageId: 'mid-test' });
    res = await app.inject({
      method: 'POST',
      url: '/wm/whatsapp/test',
      payload: { phone: '5511', message: 'oi' },
    });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('previews template and validates missing appointment', async () => {
    const app = await buildApp();

    mockedPrisma.appointment.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({
      method: 'POST',
      url: '/wm/whatsapp/preview',
      payload: { appointmentId: 'x', template: 'Oi {{paciente_nome}}' },
    });
    expect(res.statusCode).toBe(404);

    res = await app.inject({
      method: 'POST',
      url: '/wm/whatsapp/preview',
      payload: { appointmentId: 'a-1', template: 'Oi {{paciente_nome}}' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockedBuilder.buildMessage).toHaveBeenCalled();

    await app.close();
  });
});
