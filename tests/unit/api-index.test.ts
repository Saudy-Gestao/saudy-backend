import { describe, expect, it, vi } from 'vitest';

const { ready, emit } = vi.hoisted(() => ({
  ready: vi.fn().mockResolvedValue(undefined),
  emit: vi.fn(),
}));

vi.mock('../../src/app', () => ({
  default: {
    ready,
    server: { emit },
  },
}));

describe('api/index serverless handler', () => {
  it('waits for the Fastify app to be ready, then forwards req/res to its HTTP server', async () => {
    const { default: handler } = await import('../../api/index');
    const req = { url: '/health' } as any;
    const res = {} as any;

    await handler(req, res);

    expect(ready).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('request', req, res);
  });
});
