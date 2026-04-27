import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

describe('dicom-web-proxy module', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.ORTHANC_URL = 'http://orthanc.local:8042/';
    process.env.ORTHANC_AUTH = 'user:pass';
    vi.stubGlobal('fetch', fetchMock);
  });

  it('forwards GET requests and filters hop-by-hop response headers', async () => {
    fetchMock.mockResolvedValue(
      new Response('hello-orthanc', {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          connection: 'keep-alive',
        },
      }),
    );

    const app = Fastify();
    const { default: dicomWebProxyModule } = await import('../../src/modules/dicom-web-proxy');

    await app.register(dicomWebProxyModule, { prefix: '/dicom-web' });
    const res = await app.inject({
      method: 'GET',
      url: '/dicom-web/studies?limit=10',
      headers: {
        host: 'localhost:3000',
        'x-forwarded-for': '1.1.1.1',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl, init] = fetchMock.mock.calls[0];

    expect(targetUrl).toBe('http://orthanc.local:8042/dicom-web/studies?limit=10');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Basic dXNlcjpwYXNz');
    expect(init.headers.host).toBeUndefined();
    expect(init.headers.connection).toBeUndefined();

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toBe('hello-orthanc');

    await app.close();
  });

  it('forwards POST body with duplex option', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    const app = Fastify();
    const { default: dicomWebProxyModule } = await import('../../src/modules/dicom-web-proxy');

    await app.register(dicomWebProxyModule, { prefix: '/dicom-web' });
    const res = await app.inject({
      method: 'POST',
      url: '/dicom-web/qido',
      payload: { test: true },
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBeDefined();
    expect(init.duplex).toBe('half');

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true });

    await app.close();
  });

  it('joins array request headers and handles empty upstream body', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 204,
      }),
    );

    const app = Fastify();
    const { default: dicomWebProxyModule } = await import('../../src/modules/dicom-web-proxy');

    await app.register(dicomWebProxyModule, { prefix: '/dicom-web' });
    const res = await app.inject({
      method: 'HEAD',
      url: '/dicom-web/studies',
      headers: {
        accept: ['application/json', 'application/dicom'] as any,
      },
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('HEAD');
    expect(init.headers.accept).toBe('application/json,application/dicom');
    expect(init.body).toBeUndefined();

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    await app.close();
  });
});
