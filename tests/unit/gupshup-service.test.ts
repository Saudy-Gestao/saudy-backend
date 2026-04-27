import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendWhatsAppText } from '../../src/modules/care/lib/gupshupService';

describe('gupshupService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends message with normalized numbers and returns submitted status fallback', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendWhatsAppText('(21) 93618-7141', 'Ola', {
      apiKey: 'key',
      appName: 'app',
      sourceNumber: '+55 11 99999-8888',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers.apikey).toBe('key');
    expect(result).toEqual(
      expect.objectContaining({
        provider: 'gupshup',
        to: '5521936187141',
        message: 'Ola',
        status: 'submitted',
      }),
    );
  });

  it('throws when credentials are missing', async () => {
    await expect(
      sendWhatsAppText('21999998888', 'Ola', {
        apiKey: '',
        appName: 'app',
        sourceNumber: '5511999998888',
      }),
    ).rejects.toThrow('Credenciais do WhatsApp (Gupshup) não informadas.');
  });

  it('throws on non-ok response and keeps provider payload in message', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: vi.fn().mockResolvedValue({ error: 'invalid' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      sendWhatsAppText('21999998888', 'Ola', {
        apiKey: 'key',
        appName: 'app',
        sourceNumber: '5511999998888',
      }),
    ).rejects.toThrow('Gupshup error 400');
  });
});
