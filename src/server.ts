import app from './app';
import prisma from './lib/prisma';
import { syncAllBranchesHsmTemplates } from './modules/care/lib/whatsapp-hsm-sync';
import WhatsAppSchedulerJob from './modules/care/lib/whatsapp-scheduler-job';

const HSM_SYNC_INTERVAL_MINUTES = Math.max(1, Number(process.env.WHATSAPP_HSM_SYNC_INTERVAL_MINUTES) || 15);
const WHATSAPP_AUTOMATION_INTERVAL_MINUTES = Math.max(1, Number(process.env.WHATSAPP_AUTOMATION_INTERVAL_MINUTES) || 5);
const WHATSAPP_HUMAN_TIMEOUT_INTERVAL_MINUTES = Math.max(1, Number(process.env.WHATSAPP_HUMAN_TIMEOUT_INTERVAL_MINUTES) || 1);
let hsmSyncTimer: NodeJS.Timeout | null = null;
let whatsAppAutomationTimer: NodeJS.Timeout | null = null;
let whatsAppHumanTimeoutTimer: NodeJS.Timeout | null = null;
let isHsmSyncRunning = false;
let isWhatsAppAutomationRunning = false;
let isHumanTimeoutRunning = false;

const startWhatsAppHsmAutoSync = () => {
  const runSync = async () => {
    if (isHsmSyncRunning) return;
    isHsmSyncRunning = true;
    try {
      const result = await syncAllBranchesHsmTemplates();
      app.log.info({
        branches: result.branches,
        synced: result.synced,
        created: result.created,
        updated: result.updated,
      }, 'WhatsApp HSM auto-sync finished');
    } catch (error) {
      app.log.error({ err: error }, 'WhatsApp HSM auto-sync failed');
    } finally {
      isHsmSyncRunning = false;
    }
  };

  void runSync();
  hsmSyncTimer = setInterval(() => {
    void runSync();
  }, HSM_SYNC_INTERVAL_MINUTES * 60 * 1000);
};

const startWhatsAppAutomation = () => {
  const runAutomation = async () => {
    if (isWhatsAppAutomationRunning) return;
    isWhatsAppAutomationRunning = true;

    try {
      const noShowResult = await WhatsAppSchedulerJob.processNoShows();
      const confirmationResult = await WhatsAppSchedulerJob.processConfirmations();

      app.log.info({
        noShows: noShowResult,
        confirmations: confirmationResult,
      }, 'WhatsApp automation cycle finished');
    } catch (error) {
      app.log.error({ err: error }, 'WhatsApp automation cycle failed');
    } finally {
      isWhatsAppAutomationRunning = false;
    }
  };

  void runAutomation();
  whatsAppAutomationTimer = setInterval(() => {
    void runAutomation();
  }, WHATSAPP_AUTOMATION_INTERVAL_MINUTES * 60 * 1000);
};

const startWhatsAppHumanTimeoutAutomation = () => {
  const runHumanTimeoutAutomation = async () => {
    if (isHumanTimeoutRunning) return;
    isHumanTimeoutRunning = true;

    try {
      const humanConversationResult = await WhatsAppSchedulerJob.processHumanConversationTimeouts();
      app.log.info({
        humanConversations: humanConversationResult,
      }, 'WhatsApp human timeout cycle finished');
    } catch (error) {
      app.log.error({ err: error }, 'WhatsApp human timeout cycle failed');
    } finally {
      isHumanTimeoutRunning = false;
    }
  };

  void runHumanTimeoutAutomation();
  whatsAppHumanTimeoutTimer = setInterval(() => {
    void runHumanTimeoutAutomation();
  }, WHATSAPP_HUMAN_TIMEOUT_INTERVAL_MINUTES * 60 * 1000);
};

const start = async () => {
  const port = Number(process.env.PORT) || 3000;

  try {
    await prisma.$connect();

    app.log.info('✅ Databases connected');

    await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`Server listening on http://0.0.0.0:${port}`);
    startWhatsAppHsmAutoSync();
    startWhatsAppAutomation();
    startWhatsAppHumanTimeoutAutomation();
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

const shutdown = async () => {
  if (hsmSyncTimer) clearInterval(hsmSyncTimer);
  if (whatsAppAutomationTimer) clearInterval(whatsAppAutomationTimer);
  if (whatsAppHumanTimeoutTimer) clearInterval(whatsAppHumanTimeoutTimer);
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
