import type { IncomingMessage, ServerResponse } from 'http';
import 'dotenv/config';
import { isAuthorizedCronRequest, rejectUnauthorized } from './_auth';
import WhatsAppSchedulerJob from '../../src/modules/care/lib/whatsapp-scheduler-job';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!isAuthorizedCronRequest(req)) return rejectUnauthorized(res);

  try {
    const humanConversations = await WhatsAppSchedulerJob.processHumanConversationTimeouts();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, humanConversations }));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  }
}
