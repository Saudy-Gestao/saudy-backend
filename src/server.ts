import app from './app';
import prisma from './lib/prisma';
import { syncAllBranchesHsmTemplates } from './modules/care/lib/whatsapp-hsm-sync';

const HSM_SYNC_INTERVAL_MINUTES = Math.max(1, Number(process.env.WHATSAPP_HSM_SYNC_INTERVAL_MINUTES) || 15);
let hsmSyncTimer: NodeJS.Timeout | null = null;
let isHsmSyncRunning = false;

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

const start = async () => {
  const port = Number(process.env.PORT) || 3000;

  try {
    await prisma.$connect();

    app.log.info('✅ Databases connected');

    await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`Server listening on http://0.0.0.0:${port}`);
    startWhatsAppHsmAutoSync();
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

const shutdown = async () => {
  if (hsmSyncTimer) clearInterval(hsmSyncTimer);
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
