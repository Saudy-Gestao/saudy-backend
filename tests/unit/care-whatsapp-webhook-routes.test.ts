import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import whatsappWebhookRoutes from '../../src/modules/care/routes/whatsapp-webhook';
import prisma from '../../src/modules/care/lib/prisma';
import WhatsAppAutoSender from '../../src/modules/care/lib/whatsapp-auto-sender';
import handleWhatsAppChatbot from '../../src/modules/care/lib/whatsapp-chatbot';

const sendTextMessageMock = vi.fn();

vi.mock('../../src/modules/care/lib/gupshup', () => ({
  default: vi.fn().mockImplementation(() => ({
    sendTextMessage: sendTextMessageMock,
  })),
}));

vi.mock('../../src/modules/care/lib/whatsapp-auto-sender', () => ({
  default: {
    sendMessage: vi.fn(),
  },
}));

vi.mock('../../src/modules/care/lib/whatsapp-chatbot', () => ({
  default: vi.fn(),
}));

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    whatsAppConversation: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    whatsAppMessageLog: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    patient: { findMany: vi.fn() },
    whatsAppConfig: { findMany: vi.fn(), findUnique: vi.fn() },
    whatsAppConversationMessage: { findFirst: vi.fn(), create: vi.fn() },
    appointment: { findFirst: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const mockedPrisma = prisma as any;
const mockedAutoSender = WhatsAppAutoSender as any;
const mockedChatbot = handleWhatsAppChatbot as any;

async function buildApp() {
  const app = Fastify();
  await app.register(whatsappWebhookRoutes, { prefix: '/wh' });
  return app;
}

describe('care whatsapp webhook routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockedPrisma.whatsAppConversation.findMany.mockResolvedValue([]);
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValue(null);
    mockedPrisma.whatsAppConversation.upsert.mockResolvedValue({ id: 'conv-1', humanFlowKey: 'CONFIRMACAO_REAGENDAMENTO' });

    mockedPrisma.whatsAppMessageLog.findMany.mockResolvedValue([]);
    mockedPrisma.whatsAppMessageLog.findFirst.mockResolvedValue(null);
    mockedPrisma.whatsAppMessageLog.findUnique.mockResolvedValue(null);
    mockedPrisma.whatsAppMessageLog.update.mockResolvedValue({ id: 'log-1' });
    mockedPrisma.whatsAppMessageLog.updateMany.mockResolvedValue({ count: 1 });

    mockedPrisma.patient.findMany.mockResolvedValue([]);
    mockedPrisma.whatsAppConfig.findMany.mockResolvedValue([{ branchId: 'b-1', fromNumber: '5511999990000' }]);
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValue({
      branchId: 'b-1',
      accountSid: 'api-key',
      authToken: 'app-name',
      fromNumber: '5511999990000',
      isActive: true,
    });

    mockedPrisma.whatsAppConversationMessage.findFirst.mockResolvedValue(null);
    mockedPrisma.whatsAppConversationMessage.create.mockResolvedValue({ id: 'cm-1' });

    mockedPrisma.appointment.findFirst.mockResolvedValue({
      id: 'a-1',
      status: 'AGENDADO',
      observations: null,
      patientId: 'p-1',
      patientName: 'Maria',
    });
    mockedPrisma.appointment.update.mockResolvedValue({ id: 'a-1' });

    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb({
      whatsAppMessageLog: mockedPrisma.whatsAppMessageLog,
      appointment: mockedPrisma.appointment,
      whatsAppConversation: mockedPrisma.whatsAppConversation,
      whatsAppConversationMessage: mockedPrisma.whatsAppConversationMessage,
    }));

    mockedAutoSender.sendMessage.mockResolvedValue(undefined);
    mockedChatbot.mockResolvedValue({ handled: false });
    sendTextMessageMock.mockResolvedValue({ status: 'success', messageId: 'm-1' });
  });

  it('responds to health check endpoint', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/wh/whatsapp/webhook/gupshup' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    await app.close();
  });

  it('processes provider status event and returns early when no text/action', async () => {
    const app = await buildApp();

    mockedPrisma.whatsAppConversationMessage.findFirst.mockResolvedValueOnce({
      conversationId: 'conv-1',
      branchId: 'b-1',
      phone: '11999998888',
      flowKey: 'FLOW',
      metadata: {},
      conversation: { humanProtocolNumber: 'WA-20260413-ABC' },
    });
    mockedPrisma.whatsAppMessageLog.findFirst.mockResolvedValueOnce({
      id: 'log-1',
      status: 'PENDING',
      sentAt: null,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/wh/whatsapp/webhook/gupshup',
      payload: {
        type: 'message-event',
        payload: {
          type: 'sent',
          gsId: 'provider-1',
          source: '5511999998888',
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().event).toBe('SENT');
    expect(mockedPrisma.whatsAppConversationMessage.create).toHaveBeenCalled();
    expect(mockedPrisma.whatsAppMessageLog.update).toHaveBeenCalled();

    await app.close();
  });

  it('uses chatbot when action cannot be mapped and chatbot handles message', async () => {
    const app = await buildApp();
    mockedChatbot.mockResolvedValueOnce({ handled: true });

    const res = await app.inject({
      method: 'POST',
      url: '/wh/whatsapp/webhook/gupshup',
      payload: {
        payload: {
          source: '5511999998888',
          payload: { text: 'oi tudo bem' },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().chatbot).toBe(true);

    await app.close();
  });

  it('returns ignored unsupported-action when action/log is missing and chatbot does not handle', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/wh/whatsapp/webhook/gupshup',
      payload: {
        payload: {
          source: '5511999998888',
          payload: { text: 'mensagem qualquer' },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe(true);
    expect(res.json().reason).toBe('unsupported-action');

    await app.close();
  });

  it('processes confirmed action and updates appointment/logs', async () => {
    const app = await buildApp();

    mockedPrisma.whatsAppMessageLog.findUnique.mockResolvedValueOnce({
      id: 'log-1',
      appointmentId: 'a-1',
      branchId: 'b-1',
      messageType: 'APPOINTMENT_CONFIRMATION',
      status: 'SENT',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/wh/whatsapp/webhook/gupshup',
      payload: {
        payload: {
          source: '5511999998888',
          payload: { id: 'log-1', text: 'confirmar' },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().action).toBe('CONFIRMED');
    expect(mockedPrisma.$transaction).toHaveBeenCalled();
    expect(mockedAutoSender.sendMessage).toHaveBeenCalled();

    await app.close();
  });

  it('blocks binary decision when originating log is already terminal', async () => {
    const app = await buildApp();

    mockedPrisma.whatsAppMessageLog.findUnique.mockResolvedValueOnce({
      id: 'log-1',
      appointmentId: 'a-1',
      branchId: 'b-1',
      messageType: 'APPOINTMENT_CONFIRMATION',
      status: 'RESPONDED_CONFIRMED',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/wh/whatsapp/webhook/gupshup',
      payload: {
        payload: {
          source: '5511999998888',
          payload: { id: 'log-1', text: 'reagendar' },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().reason).toBe('binary-decision-locked');
    expect(sendTextMessageMock).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('returns originating-log-not-found when action exists but no matching log', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/wh/whatsapp/webhook/gupshup',
      payload: {
        payload: {
          source: '5511999998888',
          payload: { text: 'confirmar' },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe(true);
    expect(res.json().reason).toBe('originating-log-not-found');
    await app.close();
  });

  it('returns appointment-not-found when originating log exists but appointment is missing', async () => {
    const app = await buildApp();
    mockedPrisma.whatsAppMessageLog.findUnique.mockResolvedValueOnce({
      id: 'log-1',
      appointmentId: 'a-404',
      branchId: 'b-1',
      messageType: 'APPOINTMENT_CONFIRMATION',
      status: 'SENT',
    });
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'POST',
      url: '/wh/whatsapp/webhook/gupshup',
      payload: {
        payload: {
          source: '5511999998888',
          payload: { id: 'log-1', text: 'confirmar' },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().reason).toBe('appointment-not-found');
    await app.close();
  });

  it('blocks decision when conversation is already in assigned human flow', async () => {
    const app = await buildApp();
    mockedPrisma.whatsAppMessageLog.findUnique.mockResolvedValueOnce({
      id: 'log-1',
      appointmentId: 'a-1',
      branchId: 'b-1',
      messageType: 'APPOINTMENT_CONFIRMATION',
      status: 'SENT',
    });
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce({
      id: 'conv-1',
      humanStatus: 'ASSIGNED',
      humanFlowKey: 'CONFIRMACAO_REAGENDAMENTO',
      humanProtocolNumber: 'WA-20260413-ABC',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/wh/whatsapp/webhook/gupshup',
      payload: {
        payload: {
          source: '5511999998888',
          payload: { id: 'log-1', text: 'reagendar' },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().reason).toBe('blocked-by-human-flow');
    expect(sendTextMessageMock).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('processes reschedule action and queues human conversation', async () => {
    const app = await buildApp();
    mockedPrisma.whatsAppMessageLog.findUnique.mockResolvedValueOnce({
      id: 'log-1',
      appointmentId: 'a-1',
      branchId: 'b-1',
      messageType: 'APPOINTMENT_CONFIRMATION',
      status: 'SENT',
    });
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(null);
    mockedPrisma.whatsAppConversation.upsert.mockResolvedValueOnce({
      id: 'conv-1',
      humanFlowKey: 'CONFIRMACAO_REAGENDAMENTO',
      humanProtocolNumber: 'WA-20260413-XYZ',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/wh/whatsapp/webhook/gupshup',
      payload: {
        payload: {
          source: '5511999998888',
          payload: { id: 'log-1', text: 'reagendar' },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().action).toBe('RESCHEDULE');
    expect(mockedPrisma.whatsAppConversation.upsert).toHaveBeenCalled();
    expect(mockedAutoSender.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageType: 'CONFIRMATION_REPLY_RESCHEDULE',
    }));
    await app.close();
  });
});
