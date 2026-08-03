import type { IncomingMessage, ServerResponse } from 'http';

/**
 * Vercel signs cron-triggered requests with `Authorization: Bearer $CRON_SECRET`
 * (once CRON_SECRET is set as a project env var). Rejects anything else so the
 * endpoint can't be triggered by a stray public request.
 */
export function isAuthorizedCronRequest(req: IncomingMessage): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.authorization === `Bearer ${secret}`;
}

export function rejectUnauthorized(res: ServerResponse) {
  res.statusCode = 401;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}
