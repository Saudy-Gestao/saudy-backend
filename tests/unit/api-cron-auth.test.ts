import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAuthorizedCronRequest, rejectUnauthorized } from '../../api/cron/_auth';

describe('cron _auth', () => {
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it('rejects when CRON_SECRET is not configured', () => {
    const req = { headers: { authorization: 'Bearer whatever' } } as any;
    expect(isAuthorizedCronRequest(req)).toBe(false);
  });

  it('rejects when the Authorization header does not match', () => {
    process.env.CRON_SECRET = 'expected-secret';
    const req = { headers: { authorization: 'Bearer wrong' } } as any;
    expect(isAuthorizedCronRequest(req)).toBe(false);
  });

  it('authorizes a matching bearer token', () => {
    process.env.CRON_SECRET = 'expected-secret';
    const req = { headers: { authorization: 'Bearer expected-secret' } } as any;
    expect(isAuthorizedCronRequest(req)).toBe(true);
  });

  it('rejectUnauthorized writes a 401 JSON response', () => {
    const res = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn(),
    } as any;

    rejectUnauthorized(res);

    expect(res.statusCode).toBe(401);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: 'Unauthorized' }));
  });
});
