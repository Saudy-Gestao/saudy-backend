import { FastifyInstance } from 'fastify';
import WhatsAppSchedulerJob from '../lib/whatsapp-scheduler-job';

export default async function whatsappJobsRoutes(app: FastifyInstance) {
  
  /**
   * Endpoint para processar confirmações (pode ser chamado por cron job)
   */
  app.post('/whatsapp/jobs/process-confirmations', {
    schema: {
      summary: 'Process appointment confirmations (cron job)',
      tags: ['WhatsApp Jobs'],
      response: {
        200: { type: 'object' },
        500: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    try {
      const result = await WhatsAppSchedulerJob.processConfirmations();
      return {
        success: true,
        ...result,
      };
    } catch (error: any) {
      request.log.error({ err: error }, 'Failed to process confirmations');
      return reply.code(500).send({
        error: 'Erro ao processar confirmações',
        details: error.message,
      });
    }
  });

  /**
   * Endpoint para processar lembretes (pode ser chamado por cron job)
   */
  app.post('/whatsapp/jobs/process-reminders', {
    schema: {
      summary: 'Process appointment reminders (cron job)',
      tags: ['WhatsApp Jobs'],
      response: {
        200: { type: 'object' },
        500: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    try {
      const result = await WhatsAppSchedulerJob.processReminders();
      return {
        success: true,
        ...result,
      };
    } catch (error: any) {
      request.log.error({ err: error }, 'Failed to process reminders');
      return reply.code(500).send({
        error: 'Erro ao processar lembretes',
        details: error.message,
      });
    }
  });
}
