import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/modules/dicom/mwl', () => ({
  MwlScp: class MockMwlScp {
    start() {}
    stop() {}
  },
}));

describe('App integration', () => {
  let app: any;

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    const mod = await import('../../src/app');
    app = mod.default;
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('responds to health check', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('responds to root endpoint with modules list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      message: 'Saudy Monolith API',
      docs: '/docs',
    });
    expect(res.json().modules).toContain('/care');
  });

  it('responds to webhook health endpoint', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/whatsapp/webhook',
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'saudy-webhook-token',
        'hub.challenge': 'test-challenge',
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it('acknowledges webhook events safely', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/whatsapp/webhook',
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true });
  });
});
