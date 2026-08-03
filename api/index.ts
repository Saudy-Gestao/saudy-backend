import type { IncomingMessage, ServerResponse } from 'http';
import app from '../src/app';

// Fastify never calls `.listen()` here — we just let it build its route tree,
// then hand the raw req/res to its internal HTTP server instance, the same
// way `.listen()` would internally wire up a socket's 'request' event.
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await app.ready();
  app.server.emit('request', req, res);
}
