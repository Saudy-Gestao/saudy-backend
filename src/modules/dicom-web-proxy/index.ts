import { FastifyInstance } from 'fastify';
import { Readable } from 'stream';

const ORTHANC_URL = (process.env.ORTHANC_URL || 'http://localhost:8042').replace(/\/$/, '');
const ORTHANC_AUTH = process.env.ORTHANC_AUTH || 'orthanc:orthanc';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'authorization',
]);

function toOrthancHeaders(headers: Record<string, unknown>) {
  const next: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (typeof value === 'undefined') continue;

    if (Array.isArray(value)) {
      next[key] = value.join(',');
    } else {
      next[key] = String(value);
    }
  }

  next.Authorization = 'Basic ' + Buffer.from(ORTHANC_AUTH).toString('base64');
  return next;
}

function extractForwardPath(rawUrl: string) {
  const [pathname, query = ''] = rawUrl.split('?');
  const normalizedPath = pathname || '/dicom-web';
  return query ? `${normalizedPath}?${query}` : normalizedPath;
}

async function forwardToOrthanc(request: any, reply: any) {
  const forwardPath = extractForwardPath(request.raw.url || '/');
  const targetUrl = `${ORTHANC_URL}${forwardPath.startsWith('/') ? '' : '/'}${forwardPath}`;

  const method = request.method.toUpperCase();
  const headers = toOrthancHeaders(request.headers as Record<string, unknown>);

  const init: any = {
    method,
    headers,
    redirect: 'manual',
  };

  if (!['GET', 'HEAD'].includes(method)) {
    init.body = request.raw;
    init.duplex = 'half';
  }

  const orthancRes = await fetch(targetUrl, init);

  reply.code(orthancRes.status);
  orthancRes.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      reply.header(key, value);
    }
  });

  if (!orthancRes.body) {
    return reply.send();
  }

  const nodeStream = Readable.fromWeb(orthancRes.body as any);
  return reply.send(nodeStream);
}

export default async function dicomWebProxyModule(app: FastifyInstance) {
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    url: '/',
    handler: forwardToOrthanc,
  });

  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    url: '/*',
    handler: forwardToOrthanc,
  });
}
