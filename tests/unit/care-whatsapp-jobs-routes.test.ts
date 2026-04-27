import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import whatsappJobsRoutes from '../../src/modules/care/routes/whatsapp-jobs';
import WhatsAppSchedulerJob from '../../src/modules/care/lib/whatsapp-scheduler-job';

vi.mock('../../src/modules/care/lib/whatsapp-scheduler-job', () => ({
  default: {
    processConfirmations: vi.fn(),
    processReminders: vi.fn(),
  },
}));

const mockedScheduler = WhatsAppSchedulerJob as any;

async function buildApp() {
  const app = Fastify();
  await app.register(whatsappJobsRoutes, { prefix: '/jobs' });
  return app;
}

describe('care whatsapp jobs routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedScheduler.processConfirmations.mockResolvedValue({ processed: 3 });
    mockedScheduler.processReminders.mockResolvedValue({ processed: 2 });
  });

  it('processes confirmations successfully', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'POST', url: '/jobs/whatsapp/jobs/process-confirmations' });

    expect(res.statusCode).toBe(200);
    expect(mockedScheduler.processConfirmations).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('returns 500 when processing confirmations fails', async () => {
    const app = await buildApp();
    mockedScheduler.processConfirmations.mockRejectedValueOnce(new Error('confirm-fail'));

    const res = await app.inject({ method: 'POST', url: '/jobs/whatsapp/jobs/process-confirmations' });

    expect(res.statusCode).toBe(500);
    expect(mockedScheduler.processConfirmations).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('processes reminders successfully', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'POST', url: '/jobs/whatsapp/jobs/process-reminders' });

    expect(res.statusCode).toBe(200);
    expect(mockedScheduler.processReminders).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('returns 500 when processing reminders fails', async () => {
    const app = await buildApp();
    mockedScheduler.processReminders.mockRejectedValueOnce(new Error('reminder-fail'));

    const res = await app.inject({ method: 'POST', url: '/jobs/whatsapp/jobs/process-reminders' });

    expect(res.statusCode).toBe(500);
    expect(mockedScheduler.processReminders).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
