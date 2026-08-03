import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { syncAllBranchesHsmTemplates, whatsAppSchedulerJob, cleanupExpiredTemporaryDicomStudies } = vi.hoisted(() => ({
  syncAllBranchesHsmTemplates: vi.fn(),
  whatsAppSchedulerJob: {
    processNoShows: vi.fn(),
    processConfirmations: vi.fn(),
    processHumanConversationTimeouts: vi.fn(),
  },
  cleanupExpiredTemporaryDicomStudies: vi.fn(),
}));

vi.mock('../../src/modules/care/lib/whatsapp-hsm-sync', () => ({ syncAllBranchesHsmTemplates }));
vi.mock('../../src/modules/care/lib/whatsapp-scheduler-job', () => ({ default: whatsAppSchedulerJob }));
vi.mock('../../src/modules/dicom/temporary-prior-studies', () => ({ cleanupExpiredTemporaryDicomStudies }));

function fakeRes() {
  return {
    statusCode: 0,
    setHeader: vi.fn(),
    end: vi.fn(),
  } as any;
}

function authorizedReq() {
  return { headers: { authorization: 'Bearer test-secret' } } as any;
}

describe('cron handlers', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'test-secret';
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.CRON_SECRET;
  });

  it('whatsapp-hsm-sync rejects unauthorized requests', async () => {
    const { default: handler } = await import('../../api/cron/whatsapp-hsm-sync');
    const res = fakeRes();
    await handler({ headers: {} } as any, res);
    expect(res.statusCode).toBe(401);
    expect(syncAllBranchesHsmTemplates).not.toHaveBeenCalled();
  });

  it('whatsapp-hsm-sync runs the sync and returns its result', async () => {
    syncAllBranchesHsmTemplates.mockResolvedValueOnce({ branches: 2, synced: 1, created: 0, updated: 1 });
    const { default: handler } = await import('../../api/cron/whatsapp-hsm-sync');
    const res = fakeRes();

    await handler(authorizedReq(), res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ ok: true, branches: 2, synced: 1, created: 0, updated: 1 });
  });

  it('whatsapp-hsm-sync returns 500 on failure', async () => {
    syncAllBranchesHsmTemplates.mockRejectedValueOnce(new Error('sync-fail'));
    const { default: handler } = await import('../../api/cron/whatsapp-hsm-sync');
    const res = fakeRes();

    await handler(authorizedReq(), res);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ ok: false, error: 'sync-fail' });
  });

  it('whatsapp-automation returns 500 on failure', async () => {
    whatsAppSchedulerJob.processNoShows.mockRejectedValueOnce(new Error('automation-fail'));
    const { default: handler } = await import('../../api/cron/whatsapp-automation');
    const res = fakeRes();

    await handler(authorizedReq(), res);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ ok: false, error: 'automation-fail' });
  });

  it('whatsapp-automation runs both jobs and returns their results', async () => {
    whatsAppSchedulerJob.processNoShows.mockResolvedValueOnce({ sent: 1 });
    whatsAppSchedulerJob.processConfirmations.mockResolvedValueOnce({ sent: 2 });
    const { default: handler } = await import('../../api/cron/whatsapp-automation');
    const res = fakeRes();

    await handler(authorizedReq(), res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({
      ok: true,
      noShows: { sent: 1 },
      confirmations: { sent: 2 },
    });
  });

  it('whatsapp-human-timeout runs the job and returns its result', async () => {
    whatsAppSchedulerJob.processHumanConversationTimeouts.mockResolvedValueOnce({ closed: 3 });
    const { default: handler } = await import('../../api/cron/whatsapp-human-timeout');
    const res = fakeRes();

    await handler(authorizedReq(), res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ ok: true, humanConversations: { closed: 3 } });
  });

  it('whatsapp-human-timeout returns 500 on failure', async () => {
    whatsAppSchedulerJob.processHumanConversationTimeouts.mockRejectedValueOnce(new Error('human-timeout-fail'));
    const { default: handler } = await import('../../api/cron/whatsapp-human-timeout');
    const res = fakeRes();

    await handler(authorizedReq(), res);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ ok: false, error: 'human-timeout-fail' });
  });

  it('dicom-cleanup runs the cleanup and returns its result', async () => {
    cleanupExpiredTemporaryDicomStudies.mockResolvedValueOnce({ scanned: 5, deleted: 2 });
    const { default: handler } = await import('../../api/cron/dicom-cleanup');
    const res = fakeRes();

    await handler(authorizedReq(), res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ ok: true, scanned: 5, deleted: 2 });
  });

  it('dicom-cleanup returns 500 on failure', async () => {
    cleanupExpiredTemporaryDicomStudies.mockRejectedValueOnce(new Error('cleanup-fail'));
    const { default: handler } = await import('../../api/cron/dicom-cleanup');
    const res = fakeRes();

    await handler(authorizedReq(), res);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ ok: false, error: 'cleanup-fail' });
  });
});
