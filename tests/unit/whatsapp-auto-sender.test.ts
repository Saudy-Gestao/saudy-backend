import { beforeEach, describe, expect, it, vi } from 'vitest';
import WhatsAppAutoSender from '../../src/modules/care/lib/whatsapp-auto-sender';
import prisma from '../../src/modules/care/lib/prisma';

const {
  sendTemplateMessageMock,
  sendQuickReplyMessageMock,
  sendTextMessageMock,
  buildMessageMock,
  extractTemplateParamsMock,
} = vi.hoisted(() => ({
  sendTemplateMessageMock: vi.fn(),
  sendQuickReplyMessageMock: vi.fn(),
  sendTextMessageMock: vi.fn(),
  buildMessageMock: vi.fn(),
  extractTemplateParamsMock: vi.fn(),
}));

vi.mock('../../src/modules/care/lib/messaging', () => ({
  createMessagingService: vi.fn().mockImplementation(() => ({
    sendTemplateMessage: sendTemplateMessageMock,
    sendQuickReplyMessage: sendQuickReplyMessageMock,
    sendTextMessage: sendTextMessageMock,
  })),
  MetaMessagingService: vi.fn().mockImplementation(() => ({
    sendTemplateMessage: sendTemplateMessageMock,
    sendQuickReplyMessage: sendQuickReplyMessageMock,
    sendTextMessage: sendTextMessageMock,
  })),
}));

vi.mock('../../src/modules/care/lib/whatsapp-message-builder', () => ({
  default: { buildMessage: buildMessageMock, extractTemplateParams: extractTemplateParamsMock },
}));

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    appointment: { findFirst: vi.fn() },
    patient: { findUnique: vi.fn(), findFirst: vi.fn() },
    whatsAppConfig: { findUnique: vi.fn() },
    whatsAppNotificationConfig: { findUnique: vi.fn() },
    branch: { findUnique: vi.fn() },
    whatsAppMessageTemplate: { findFirst: vi.fn(), findMany: vi.fn() },
    whatsAppMessageLog: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    preSchedulingFlow: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

const mockedPrisma = prisma as any;
const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

describe('whatsapp auto sender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PUBLIC_APP_URL = 'https://app.example.com';

    mockedPrisma.appointment.findFirst.mockResolvedValue({
      id: 'a-1',
      patientId: 'p-1',
      patientName: 'Maria',
      patientCpf: '12345678901',
      doctorName: 'Dr A',
      specialty: 'CARDIO',
      date: '2026-04-20',
      time: '10:00',
      convenio: 'Plano',
      observations: null,
    });
    mockedPrisma.patient.findUnique.mockResolvedValue({ cellphone: '5511999998888' });
    mockedPrisma.patient.findFirst.mockResolvedValue({
      id: 'p-1',
      name: 'Maria',
      cpf: '12345678901',
      cellphone: '5511999998888',
      phone: null,
    });
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValue({
      isActive: true,
      accountSid: 'api-key',
      authToken: 'app-name',
      fromNumber: '5511999990000',
    });
    mockedPrisma.whatsAppNotificationConfig.findUnique.mockResolvedValue({
      sendOnAppointmentCreated: true,
      sendConfirmationEnabled: true,
      sendReminderEnabled: true,
    });
    mockedPrisma.branch.findUnique.mockResolvedValue({ tradeName: 'Saudy', address: 'Rua A' });
    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValue({
      message: 'Olá {{patientName}}',
      hsmTemplateApproved: false,
    });
    mockedPrisma.whatsAppMessageTemplate.findMany.mockResolvedValue([{
      branchId: 'b-1',
      message: 'Olá {{patientName}}',
      hsmTemplateApproved: false,
    }]);
    mockedPrisma.whatsAppMessageLog.findFirst.mockResolvedValue(null);
    mockedPrisma.whatsAppMessageLog.create.mockResolvedValue({ id: 'log-1' });
    mockedPrisma.whatsAppMessageLog.update.mockResolvedValue({ id: 'log-1' });
    mockedPrisma.preSchedulingFlow.findUnique.mockResolvedValue(null);
    mockedPrisma.preSchedulingFlow.upsert.mockResolvedValue({ id: 'flow-1' });
    buildMessageMock.mockReturnValue('mensagem pronta');
    extractTemplateParamsMock.mockReturnValue(['Maria']);
    sendTemplateMessageMock.mockResolvedValue({ status: 'success', messageId: 'm-hsm' });
    sendQuickReplyMessageMock.mockResolvedValue({ status: 'success', messageId: 'm-qr' });
    sendTextMessageMock.mockResolvedValue({ status: 'success', messageId: 'm-text' });
  });

  it('returns error when appointment is not found', async () => {
    mockedPrisma.appointment.findFirst.mockResolvedValueOnce(null);
    const result = await WhatsAppAutoSender.sendMessage({ branchId: 'b-1', appointmentId: 'a-x', messageType: 'APPOINTMENT_CREATED' });
    expect(result.success).toBe(false);
  });

  it('returns error and logs failure when patient phone is missing', async () => {
    mockedPrisma.patient.findUnique.mockResolvedValueOnce({ cellphone: null });
    const result = await WhatsAppAutoSender.sendMessage({ branchId: 'b-1', appointmentId: 'a-1', messageType: 'APPOINTMENT_CREATED' });
    expect(result.success).toBe(false);
    expect(mockedPrisma.whatsAppMessageLog.create).toHaveBeenCalled();
  });

  it('blocks send when branch whatsapp is inactive', async () => {
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({
      isActive: false,
      accountSid: 'api-key',
      authToken: 'app-name',
      fromNumber: '5511999990000',
    });
    const result = await WhatsAppAutoSender.sendMessage({ branchId: 'b-1', appointmentId: 'a-1', messageType: 'APPOINTMENT_CREATED' });
    expect(result.success).toBe(false);
  });

  it('blocks send when notification type is disabled', async () => {
    mockedPrisma.whatsAppNotificationConfig.findUnique.mockResolvedValueOnce({
      sendOnAppointmentCreated: false,
      sendConfirmationEnabled: true,
      sendReminderEnabled: true,
    });
    const result = await WhatsAppAutoSender.sendMessage({ branchId: 'b-1', appointmentId: 'a-1', messageType: 'APPOINTMENT_CREATED' });
    expect(result.success).toBe(false);
  });

  it('returns failure when message template is not found', async () => {
    mockedPrisma.whatsAppMessageTemplate.findMany.mockResolvedValueOnce([]);

    const result = await WhatsAppAutoSender.sendMessage({
      branchId: 'b-1',
      appointmentId: 'a-1',
      messageType: 'APPOINTMENT_CREATED',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Template de mensagem não encontrado');
  });

  it('returns failure when whatsapp credentials are incomplete', async () => {
    const incompleteConfig = {
      isActive: true,
      accountSid: '',
      authToken: 'app-name',
      fromNumber: '5511999990000',
    };
    mockedPrisma.whatsAppConfig.findUnique
      .mockResolvedValueOnce(incompleteConfig)
      .mockResolvedValueOnce(incompleteConfig);

    const result = await WhatsAppAutoSender.sendMessage({
      branchId: 'b-1',
      appointmentId: 'a-1',
      messageType: 'APPOINTMENT_REMINDER',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('não está configurado');
  });

  it('falls back from template and quick reply to text for confirmation', async () => {
    mockedPrisma.whatsAppMessageTemplate.findMany.mockResolvedValueOnce([{
      branchId: 'b-1',
      message: 'Confirme {{patientName}}',
      hsmTemplateApproved: true,
      hsmTemplateId: 'tpl-1',
    }]);
    sendTemplateMessageMock.mockResolvedValueOnce({ status: 'error', error: 'hsm-fail' });
    sendQuickReplyMessageMock.mockResolvedValueOnce({ status: 'error', error: 'qr-fail' });
    sendTextMessageMock.mockResolvedValueOnce({ status: 'success', messageId: 'm-text' });

    const result = await WhatsAppAutoSender.sendMessage({ branchId: 'b-1', appointmentId: 'a-1', messageType: 'APPOINTMENT_CONFIRMATION' });
    expect(result.success).toBe(true);
    expect(sendTemplateMessageMock).toHaveBeenCalled();
    expect(sendQuickReplyMessageMock).toHaveBeenCalled();
    expect(sendTextMessageMock).toHaveBeenCalled();
  });

  it('returns failure when sending provider fails', async () => {
    sendTextMessageMock.mockResolvedValueOnce({ status: 'error', error: 'provider-down' });
    const result = await WhatsAppAutoSender.sendMessage({ branchId: 'b-1', appointmentId: 'a-1', messageType: 'APPOINTMENT_REMINDER' });
    expect(result.success).toBe(false);
    expect(mockedPrisma.whatsAppMessageLog.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'FAILED' }),
    }));
  });

  it('creates documents link and normalizes cpf when needed', async () => {
    const url = await WhatsAppAutoSender.ensureDocumentsLink({
      branchId: 'b-1',
      appointment: { id: 'a-1', patientId: 'p-1', patientName: 'Maria', patientCpf: '123.456.789-01' },
      patientPhone: '5511999998888',
    });

    expect(url).toContain('/pre-atendimento/documentos/');
    expect(mockedPrisma.preSchedulingFlow.upsert).toHaveBeenCalled();
  });

  it('handles no-show helper paths', async () => {
    mockedPrisma.whatsAppMessageLog.findFirst.mockResolvedValueOnce({ id: 'log-1' });
    await WhatsAppAutoSender.sendNoShowMessageIfNeeded('b-1', 'a-1');

    mockedPrisma.whatsAppMessageLog.findFirst.mockResolvedValueOnce(null);
    await WhatsAppAutoSender.sendNoShowMessageIfNeeded('b-1', 'a-1');
    expect(mockedPrisma.whatsAppMessageLog.findFirst).toHaveBeenCalledTimes(2);
  });

  it('swallows createFailedLog persistence errors', async () => {
    mockedPrisma.whatsAppMessageLog.create.mockRejectedValueOnce(new Error('log-write-fail'));

    await expect(
      WhatsAppAutoSender.createFailedLog({
        branchId: 'b-1',
        appointmentId: 'a-1',
        patientName: 'Maria',
        patientPhone: '5511999998888',
        messageType: 'APPOINTMENT_CREATED',
        errorMessage: 'x',
      }),
    ).resolves.toBeUndefined();
  });

  it('logs warning on fire-and-forget created-message failure and handles rejection path', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const sendSpy = vi
      .spyOn(WhatsAppAutoSender, 'sendMessage')
      .mockResolvedValueOnce({ success: false, error: 'not-sent' })
      .mockRejectedValueOnce(new Error('send-crash'));

    WhatsAppAutoSender.sendAppointmentCreatedMessage('b-1', 'a-1');
    await flushPromises();

    WhatsAppAutoSender.sendAppointmentCreatedMessage('b-1', 'a-2');
    await flushPromises();

    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('swallows sendNoShowMessageIfNeeded errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(WhatsAppAutoSender, 'hasPendingOrSentLog').mockRejectedValueOnce(new Error('lookup-fail'));

    await expect(WhatsAppAutoSender.sendNoShowMessageIfNeeded('b-1', 'a-1')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
