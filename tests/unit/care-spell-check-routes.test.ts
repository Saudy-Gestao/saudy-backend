import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

async function buildApp(opts?: { unauthorized?: boolean; withApiKey?: boolean }) {
  vi.resetModules();
  if (opts?.withApiKey) process.env.GROQ_API_KEY = 'groq-key';
  else process.env.GROQ_API_KEY = '';

  const mod = await import('../../src/modules/care/routes/spell-check');
  const spellCheckRoutes = mod.default;

  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1' };
  });

  await app.register(spellCheckRoutes, { prefix: '/spell-check' });
  return app;
}

describe('care spell-check routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('handles auth and missing provider config', async () => {
    const unauth = await buildApp({ unauthorized: true, withApiKey: true });
    let res = await unauth.inject({ method: 'POST', url: '/spell-check', payload: { html: '<p>x</p>' } });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    const app = await buildApp({ withApiKey: false });
    res = await app.inject({ method: 'POST', url: '/spell-check', payload: { html: '<p>x</p>' } });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('validates payload and handles provider api errors', async () => {
    const app = await buildApp({ withApiKey: true });

    let res = await app.inject({ method: 'POST', url: '/spell-check', payload: { html: '   ' } });
    expect(res.statusCode).toBe(400);

    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { message: 'api-down' } }),
    } as any);

    res = await app.inject({ method: 'POST', url: '/spell-check', payload: { html: '<p>txto</p>' } });
    expect(res.statusCode).toBe(502);

    fetchMock.mockRejectedValueOnce(new Error('network'));
    res = await app.inject({ method: 'POST', url: '/spell-check', payload: { html: '<p>txto</p>' } });
    expect(res.statusCode).toBe(502);

    await app.close();
  });

  it('returns corrected html on success', async () => {
    const app = await buildApp({ withApiKey: true });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '<p>texto</p>' } }] }),
    } as any);

    const res = await app.inject({ method: 'POST', url: '/spell-check', payload: { html: '<p>txto</p>' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().correctedHtml).toBe('<p>texto</p>');

    await app.close();
  });
});
