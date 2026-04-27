import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import GupshupService from '../../src/modules/care/lib/gupshup';

const client = {
  post: vi.fn(),
  get: vi.fn(),
  defaults: { headers: { apikey: 'api-key' } },
};

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => client),
    get: vi.fn(),
  },
}));

const mockedAxios = axios as any;

describe('GupshupService lib', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends text message success and normalizes number', async () => {
    client.post.mockResolvedValue({ status: 200, data: { status: 'submitted', messageId: 'm1' } });
    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '(11) 99999-0000' });

    const res = await service.sendTextMessage({ to: '11988887777', message: 'Oi' });
    expect(res).toEqual({ status: 'success', messageId: 'm1' });
    expect(client.post).toHaveBeenCalled();
  });

  it('accepts text message success payload with status success and adds country code to 10-digit numbers', async () => {
    client.post.mockResolvedValueOnce({ status: 200, data: { status: 'success', messageId: 'm2' } });
    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '1188887777' });

    const res = await service.sendTextMessage({ to: '1188887777', message: 'Oi' });

    expect(res).toEqual({ status: 'success', messageId: 'm2' });
    expect(client.post).toHaveBeenCalledWith('/msg', expect.stringContaining('source=551188887777'));
    expect(client.post).toHaveBeenCalledWith('/msg', expect.stringContaining('destination=551188887777'));
  });

  it('returns error with hints in sendTextMessage', async () => {
    client.post.mockRejectedValue({ response: { status: 401, data: { message: 'unauthorized' } }, message: 'x' });
    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '5511999990000' });

    const res = await service.sendTextMessage({ to: '5511988887777', message: 'Oi' });
    expect(res.status).toBe('error');
    expect(String(res.error)).toContain('Verifique se a API Key está correta');
  });

  it('adds 403 and rate-limit hints in sendTextMessage errors', async () => {
    client.post
      .mockRejectedValueOnce({ response: { status: 403, data: { error: 'forbidden' } }, message: 'x' })
      .mockRejectedValueOnce({ response: { status: 429, data: { error: { code: 'E_RATE_LIMIT' } } }, message: 'x' });

    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '5511999990000' });

    const forbidden = await service.sendTextMessage({ to: '5511988887777', message: 'Oi' });
    const limited = await service.sendTextMessage({ to: '5511988887777', message: 'Oi' });

    expect(String(forbidden.error)).toContain('número de origem está aprovado');
    expect(String(limited.error)).toContain('Limite de envio atingido');
  });

  it('falls back to stringified payload and default text error when sendTextMessage provider details are absent', async () => {
    client.post
      .mockResolvedValueOnce({ status: 200, data: { status: 'queued', foo: 'text-fallback' } })
      .mockRejectedValueOnce({});

    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '5511999990000' });

    const textQueued = await service.sendTextMessage({ to: '5511988887777', message: 'Oi' });
    const textFailed = await service.sendTextMessage({ to: '5511988887777', message: 'Oi' });

    expect(String(textQueued.error)).toContain('{"status":"queued","foo":"text-fallback"}');
    expect(textFailed.error).toBe('Erro ao enviar mensagem');
  });

  it('returns non-success payload errors for text, quick and template responses', async () => {
    client.post
      .mockResolvedValueOnce({ status: 200, data: { status: 'queued', message: 'text-not-submitted' } })
      .mockResolvedValueOnce({ status: 200, data: { status: 'queued', message: 'quick-not-submitted' } })
      .mockResolvedValueOnce({ status: 200, data: { status: 'queued', message: 'tpl-not-submitted' } });

    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '5511999990000' });

    const text = await service.sendTextMessage({ to: '5511988887777', message: 'Oi' });
    const quick = await service.sendQuickReplyMessage({
      to: '5511988887777',
      body: 'Escolha',
      options: [{ title: 'Sim' }],
    });
    const template = await service.sendTemplateMessage({
      to: '5511988887777',
      templateId: 'tpl-1',
      params: ['A'],
    });

    expect(text.status).toBe('error');
    expect(String(text.error)).toContain('text-not-submitted');
    expect(quick.status).toBe('error');
    expect(String(quick.error)).toContain('quick-not-submitted');
    expect(template.status).toBe('error');
    expect(String(template.error)).toContain('tpl-not-submitted');
  });

  it('sends quick reply and template', async () => {
    client.post
      .mockResolvedValueOnce({ status: 200, data: { status: 'submitted', messageId: 'q1' } })
      .mockResolvedValueOnce({ status: 200, data: { status: 'success', messageId: 't1' } });

    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '5511999990000' });

    const quick = await service.sendQuickReplyMessage({
      to: '5511988887777',
      body: 'Escolha',
      options: [{ title: 'Sim' }],
    });
    const template = await service.sendTemplateMessage({
      to: '5511988887777',
      templateId: 'tpl-1',
      params: ['A', 'B'],
    });

    expect(quick.status).toBe('success');
    expect(template.status).toBe('success');
  });

  it('sends quick reply with msgId, footer and postback text', async () => {
    client.post.mockResolvedValueOnce({ status: 200, data: { status: 'success', messageId: 'q2' } });

    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '5511999990000' });
    const quick = await service.sendQuickReplyMessage({
      to: '5511988887777',
      body: 'Escolha',
      footer: 'rodape',
      msgId: 'msg-1',
      options: [{ title: 'Sim', postbackText: 'SIM' }],
    });

    expect(quick.status).toBe('success');
    expect(client.post).toHaveBeenCalledWith('/msg', expect.stringContaining('destination=5511988887777'));
    expect(client.post.mock.calls[0][1]).toContain('msgid');
    expect(client.post.mock.calls[0][1]).toContain('rodape');
    expect(client.post.mock.calls[0][1]).toContain('SIM');
  });

  it('returns error on quick reply and template failures', async () => {
    client.post
      .mockRejectedValueOnce({ response: { status: 400, data: { message: 'bad quick' } }, message: 'x' })
      .mockRejectedValueOnce({ response: { status: 400, data: { error: 'bad template' } }, message: 'x' });

    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '5511999990000' });

    const quick = await service.sendQuickReplyMessage({
      to: '5511988887777',
      body: 'Escolha',
      options: [{ title: 'Sim' }],
    });
    const template = await service.sendTemplateMessage({
      to: '5511988887777',
      templateId: 'tpl-1',
      params: ['A'],
    });

    expect(quick.status).toBe('error');
    expect(template.status).toBe('error');
  });

  it('falls back to stringified provider payload for quick reply failures without message or error', async () => {
    client.post.mockRejectedValueOnce({ response: { data: { foo: 'quick-error-fallback' } } });

    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '5511999990000' });
    const quick = await service.sendQuickReplyMessage({
      to: '5511988887777',
      body: 'Escolha',
      options: [{ title: 'Sim' }],
    });

    expect(quick.status).toBe('error');
    expect(String(quick.error)).toContain('{"foo":"quick-error-fallback"}');
  });

  it('falls back to transport message for quick reply failures without provider payload', async () => {
    client.post.mockRejectedValueOnce({ message: 'quick-transport-down' });

    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '5511999990000' });
    const quick = await service.sendQuickReplyMessage({
      to: '5511988887777',
      body: 'Escolha',
      options: [{ title: 'Sim' }],
    });

    expect(quick.status).toBe('error');
    expect(quick.error).toBe('quick-transport-down');
  });

  it('falls back to stringified payload and plain error messages for template operations', async () => {
    client.post
      .mockResolvedValueOnce({ status: 200, data: { status: 'queued', foo: 'bar' } })
      .mockRejectedValueOnce({ message: 'template-fail-without-response' });

    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '5511999990000' });

    const templateQueued = await service.sendTemplateMessage({
      to: '5511988887777',
      templateId: 'tpl-1',
      params: ['A'],
    });
    const templateFailed = await service.sendTemplateMessage({
      to: '5511988887777',
      templateId: 'tpl-1',
      params: ['A'],
    });

    expect(String(templateQueued.error)).toContain('{"status":"queued","foo":"bar"}');
    expect(String(templateFailed.error)).toContain('template-fail-without-response');
  });

  it('gets message status and throws errors', async () => {
    client.get.mockResolvedValueOnce({ data: { status: 'ok' } }).mockRejectedValueOnce({ message: 'fail' });
    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '5511999990000' });

    await expect(service.getMessageStatus('m1')).resolves.toEqual({ status: 'ok' });
    await expect(service.getMessageStatus('m2')).rejects.toThrow('fail');
  });

  it('throws provider message in getMessageStatus error branch', async () => {
    client.get.mockRejectedValueOnce({ response: { data: { message: 'provider-msg' } }, message: 'fallback' });
    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '5511999990000' });

    await expect(service.getMessageStatus('m3')).rejects.toThrow('provider-msg');
  });

  it('throws transport error message in getMessageStatus when provider payload is absent', async () => {
    client.get.mockRejectedValueOnce({ message: 'network-down' });
    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '5511999990000' });

    await expect(service.getMessageStatus('m5')).rejects.toThrow('network-down');
  });

  it('throws default status lookup message when provider error has no details', async () => {
    client.get.mockRejectedValueOnce({});
    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '5511999990000' });

    await expect(service.getMessageStatus('m4')).rejects.toThrow('Erro ao consultar status');
  });

  it('tries multiple endpoints in getMediaUrl and returns null when all fail', async () => {
    client.get.mockRejectedValueOnce({ response: { status: 404 } });
    mockedAxios.get
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce({ data: { media: { url: 'https://media-url' } }, status: 200 });

    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '5511999990000' });
    const media = await service.getMediaUrl('wamid.1');
    expect(media).toEqual({ url: 'https://media-url' });

    client.get.mockRejectedValueOnce({ response: { status: 404 } });
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 404 } }).mockRejectedValueOnce({ response: { status: 404 } });
    const mediaNull = await service.getMediaUrl('wamid.2');
    expect(mediaNull).toBeNull();
  });

  it('returns media url from direct url and plain string response formats', async () => {
    client.get.mockResolvedValueOnce({ data: { url: 'https://from-data-url' }, status: 200 });
    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '5511999990000' });

    const direct = await service.getMediaUrl('wamid.3');
    expect(direct).toEqual({ url: 'https://from-data-url' });

    client.get.mockResolvedValueOnce({ data: 'https://from-string-url', status: 200 });
    const plain = await service.getMediaUrl('wamid.4');
    expect(plain).toEqual({ url: 'https://from-string-url' });
  });

  it('continues when an endpoint returns 200 without url and handles outer catch', async () => {
    client.get.mockResolvedValueOnce({ data: { foo: 'bar' }, status: 200 });
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 404 } }).mockResolvedValueOnce({ data: { url: 'https://after-empty-response' }, status: 200 });

    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '5511999990000' });
    const media = await service.getMediaUrl('wamid.5');
    expect(media).toEqual({ url: 'https://after-empty-response' });

    (client as any).defaults = undefined;
    client.get.mockRejectedValueOnce({ response: { status: 404 } });
    const mediaNull = await service.getMediaUrl('wamid.6');
    expect(mediaNull).toBeNull();
  });

  it('returns null when endpoint construction fails before the retry loop', async () => {
    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '5511999990000' });

    const mediaNull = await service.getMediaUrl(Symbol('bad-media-id') as any);
    expect(mediaNull).toBeNull();
  });

  it('returns null when outer media catch receives provider response data', async () => {
    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '5511999990000' });
    const badMediaId = {
      [Symbol.toPrimitive]() {
        throw { response: { status: 500, data: { error: 'explode' } } };
      },
    };

    const mediaNull = await service.getMediaUrl(badMediaId as any);

    expect(mediaNull).toBeNull();
  });

  it('keeps numbers already normalized with country code', async () => {
    client.post.mockResolvedValueOnce({ status: 200, data: { status: 'submitted', messageId: 'm3' } });
    const service = new GupshupService({ apiKey: 'k', appName: 'app', sourceNumber: '5511999990000' });

    const res = await service.sendTextMessage({ to: '5511988887777', message: 'Oi' });

    expect(res.status).toBe('success');
    expect(client.post).toHaveBeenCalledWith('/msg', expect.stringContaining('destination=5511988887777'));
    expect(client.post).toHaveBeenCalledWith('/msg', expect.not.stringContaining('destination=555511988887777'));
  });
});
