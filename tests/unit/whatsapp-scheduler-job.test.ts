import { beforeEach, describe, expect, it, vi } from 'vitest';
import WhatsAppSchedulerJob from '../../src/modules/care/lib/whatsapp-scheduler-job';
import prisma from '../../src/modules/care/lib/prisma';
import WhatsAppAutoSender from '../../src/modules/care/lib/whatsapp-auto-sender';

const sendTextMessageMock = vi.fn();

vi.mock('../../src/modules/care/lib/gupshup', () => ({
  default: vi.fn().mockImplementation(() => ({
    sendTextMessage: sendTextMessageMock,
  })),
}));

vi.mock('../../src/modules/care/lib/whatsapp-auto-sender', () => ({
  default: {
    sendMessage: vi.fn(),
    hasPendingOrSentLog: vi.fn(),
  },
}));

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    whatsAppConversation: { findMany: vi.fn(), update: vi.fn() },
    whatsAppConversationSettings: { findUnique: vi.fn() },
    whatsAppConfig: { findUnique: vi.fn() },
    whatsAppConversationMessage: { create: vi.fn() },
    whatsAppNotificationConfig: { findMany: vi.fn() },
    whatsAppMessageLog: { findFirst: vi.fn() },
    branch: { findMany: vi.fn(), findUnique: vi.fn() },
    branchSettings: { findUnique: vi.fn() },
    appointment: { findMany: vi.fn() },
    $transaction: vi.fn(),
    mwlEntry: { updateMany: vi.fn() },
  },
}));

const mockedPrisma = prisma as any;
const mockedAutoSender = WhatsAppAutoSender as any;

describe('whatsapp scheduler job', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockedPrisma.whatsAppConversation.findMany.mockResolvedValue([]);
    mockedPrisma.whatsAppConversation.update.mockResolvedValue({ id: 'conv-1' });
    mockedPrisma.whatsAppConversationSettings.findUnique.mockResolvedValue({ idleTimeoutMinutes: 10, closeWarningMinutes: 5 });
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValue({
      isActive: true,
      accountSid: 'api-key',
      authToken: 'app-name',
      fromNumber: '5511999990000',
    });
    mockedPrisma.whatsAppConversationMessage.create.mockResolvedValue({ id: 'msg-1' });
    mockedPrisma.whatsAppNotificationConfig.findMany.mockResolvedValue([]);
    mockedPrisma.whatsAppMessageLog.findFirst.mockResolvedValue(null);
    mockedPrisma.branch.findMany.mockResolvedValue([{ id: 'b-1' }]);
    mockedPrisma.branch.findUnique.mockResolvedValue({ companyId: null });
    mockedPrisma.branchSettings.findUnique.mockResolvedValue({ noShowToleranceMinutes: 30 });
    mockedPrisma.appointment.findMany.mockResolvedValue([]);
    mockedPrisma.mwlEntry.updateMany.mockResolvedValue({ count: 0 });
    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb({
      whatsAppConversation: mockedPrisma.whatsAppConversation,
      whatsAppConversationMessage: mockedPrisma.whatsAppConversationMessage,
      appointment: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      mwlEntry: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    }));

    mockedAutoSender.sendMessage.mockResolvedValue({ success: true });
    mockedAutoSender.hasPendingOrSentLog.mockResolvedValue(false);
    sendTextMessageMock.mockResolvedValue({ status: 'success', messageId: 'm-1' });
  });

  it('processes confirmations with sent and failed counters', async () => {
    mockedPrisma.whatsAppNotificationConfig.findMany.mockResolvedValueOnce([
      { branchId: 'b-1', confirmationHoursBefore: 1000000 },
    ]);
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([
      { id: 'a-1', date: '2099-01-01', time: '10:00' },
      { id: 'a-2', date: '2099-01-01', time: '11:00' },
    ]);
    mockedPrisma.whatsAppMessageLog.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockedAutoSender.sendMessage
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'send-fail' });

    const result = await WhatsAppSchedulerJob.processConfirmations();
    expect(result.processed).toBe(2);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('processes no-shows by branch and sends notifications when needed', async () => {
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([{ id: 'a-1' }, { id: 'a-2' }]);
    mockedAutoSender.hasPendingOrSentLog
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const result = await WhatsAppSchedulerJob.processNoShows();
    expect(result.processed).toBe(2);
    expect(result.updated).toBe(2);
    expect(result.notified).toBe(1);
  });

  it('warns human conversations on idle timeout', async () => {
    const elevenMinutesAgo = new Date(Date.now() - (11 * 60 * 1000));
    mockedPrisma.whatsAppConversation.findMany.mockResolvedValueOnce([
      {
        id: 'conv-1',
        branchId: 'b-1',
        phone: '5511999998888',
        humanStatus: 'ASSIGNED',
        humanAssignedUserId: 'u-1',
        humanAssignedUserName: 'Atendente',
        humanFlowKey: 'DUVIDAS',
        humanIdleWarningSentAt: null,
        humanLastOperatorMessageAt: elevenMinutesAgo,
        humanLastPatientMessageAt: null,
      },
    ]);

    const result = await WhatsAppSchedulerJob.processHumanConversationTimeouts();
    expect(result.warned).toBe(1);
    expect(result.closed).toBe(0);
  });

  it('closes human conversations after warning window expires', async () => {
    const warnedAgo = new Date(Date.now() - (6 * 60 * 1000));
    mockedPrisma.whatsAppConversation.findMany.mockResolvedValueOnce([
      {
        id: 'conv-1',
        branchId: 'b-1',
        phone: '5511999998888',
        humanStatus: 'ASSIGNED',
        humanAssignedUserId: 'u-1',
        humanAssignedUserName: 'Atendente',
        humanFlowKey: 'DUVIDAS',
        humanProtocolNumber: 'WA-123',
        humanIdleWarningSentAt: warnedAgo,
        humanLastOperatorMessageAt: new Date(Date.now() - (20 * 60 * 1000)),
        humanLastPatientMessageAt: null,
      },
    ]);

    const result = await WhatsAppSchedulerJob.processHumanConversationTimeouts();
    expect(result.closed).toBe(1);
  });

  it('skips warning when branch messaging config is inactive', async () => {
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ isActive: false });
    mockedPrisma.whatsAppConversation.findMany.mockResolvedValueOnce([
      {
        id: 'conv-1',
        branchId: 'b-1',
        phone: '5511999998888',
        humanStatus: 'ASSIGNED',
        humanAssignedUserId: 'u-1',
        humanAssignedUserName: 'Atendente',
        humanFlowKey: 'DUVIDAS',
        humanIdleWarningSentAt: null,
        humanLastOperatorMessageAt: new Date(Date.now() - (20 * 60 * 1000)),
        humanLastPatientMessageAt: null,
      },
    ]);

    const result = await WhatsAppSchedulerJob.processHumanConversationTimeouts();
    expect(result).toEqual({ warned: 0, closed: 0, failed: 0 });
    expect(sendTextMessageMock).not.toHaveBeenCalled();
  });

  it('returns failed counter when one conversation raises processing error', async () => {
    mockedPrisma.whatsAppConversation.findMany.mockResolvedValueOnce([
      {
        id: 'conv-1',
        branchId: 'b-1',
        phone: '5511999998888',
        humanStatus: 'ASSIGNED',
        humanAssignedUserId: 'u-1',
        humanAssignedUserName: 'Atendente',
        humanFlowKey: 'DUVIDAS',
        humanIdleWarningSentAt: null,
        humanLastOperatorMessageAt: new Date(Date.now() - (20 * 60 * 1000)),
        humanLastPatientMessageAt: null,
      },
    ]);
    mockedPrisma.whatsAppConversationSettings.findUnique.mockRejectedValueOnce(new Error('settings-fail'));

    const result = await WhatsAppSchedulerJob.processHumanConversationTimeouts();
    expect(result.failed).toBe(1);
  });

  it('returns zeroed counters when confirmations listing fails', async () => {
    mockedPrisma.whatsAppNotificationConfig.findMany.mockRejectedValueOnce(new Error('cfg-fail'));

    const result = await WhatsAppSchedulerJob.processConfirmations();
    expect(result).toEqual({ processed: 0, sent: 0, failed: 0 });
  });

  it('returns zeroed counters when no-shows branch listing fails', async () => {
    mockedPrisma.branch.findMany.mockRejectedValueOnce(new Error('branch-fail'));

    const result = await WhatsAppSchedulerJob.processNoShows();
    expect(result).toEqual({ processed: 0, updated: 0, notified: 0, failed: 0 });
  });

  it('skips idle processing when operator did not send last message or patient already replied', async () => {
    mockedPrisma.whatsAppConversation.findMany.mockResolvedValueOnce([
      {
        id: 'conv-no-operator',
        branchId: 'b-1',
        phone: '5511999998888',
        humanStatus: 'ASSIGNED',
        humanAssignedUserId: 'u-1',
        humanAssignedUserName: 'Atendente',
        humanFlowKey: 'DUVIDAS',
        humanIdleWarningSentAt: null,
        humanLastOperatorMessageAt: null,
        humanLastPatientMessageAt: null,
      },
      {
        id: 'conv-patient-replied',
        branchId: 'b-1',
        phone: '5511999998888',
        humanStatus: 'ASSIGNED',
        humanAssignedUserId: 'u-1',
        humanAssignedUserName: 'Atendente',
        humanFlowKey: 'DUVIDAS',
        humanIdleWarningSentAt: null,
        humanLastOperatorMessageAt: new Date(Date.now() - (20 * 60 * 1000)),
        humanLastPatientMessageAt: new Date(Date.now() - (5 * 60 * 1000)),
      },
    ]);

    const result = await WhatsAppSchedulerJob.processHumanConversationTimeouts();
    expect(result).toEqual({ warned: 0, closed: 0, failed: 0 });
    expect(sendTextMessageMock).not.toHaveBeenCalled();
  });

  it('returns early when there are no no-show candidates', async () => {
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([]);

    const result = await WhatsAppSchedulerJob.processNoShows();
    expect(result).toEqual({ processed: 0, updated: 0, notified: 0, failed: 0 });
  });

  it('counts failed no-show notification sends', async () => {
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([{ id: 'a-1' }]);
    mockedAutoSender.hasPendingOrSentLog.mockResolvedValueOnce(false);
    mockedAutoSender.sendMessage.mockResolvedValueOnce({ success: false, error: 'send-fail' });

    const result = await WhatsAppSchedulerJob.processNoShows();
    expect(result).toEqual({ processed: 1, updated: 1, notified: 0, failed: 1 });
  });

  it('skips confirmations with existing log or missing date/time and exposes reminders noop', async () => {
    mockedPrisma.whatsAppNotificationConfig.findMany.mockResolvedValueOnce([
      { branchId: 'b-1', confirmationHoursBefore: 1000000 },
    ]);
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([
      { id: 'a-existing', date: '2099-01-01', time: '10:00' },
      { id: 'a-missing-time', date: '2099-01-01', time: null },
    ]);
    mockedPrisma.whatsAppMessageLog.findFirst
      .mockResolvedValueOnce({ id: 'log-existing' })
      .mockResolvedValueOnce(null);

    const confirmations = await WhatsAppSchedulerJob.processConfirmations();
    expect(confirmations).toEqual({ processed: 2, sent: 0, failed: 0 });

    const reminders = await WhatsAppSchedulerJob.processReminders();
    expect(reminders).toEqual({ processed: 0, sent: 0, failed: 0 });
  });
});
