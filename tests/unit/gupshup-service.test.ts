import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { GupshupService } from '../../src/modules/care/lib/messaging';

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      post: vi.fn(),
      get: vi.fn(),
      defaults: { headers: { apikey: 'api-key' } },
    })),
    post: vi.fn(),
    get: vi.fn(),
  },
}));

const mockedAxios = axios as any;

describe('GupshupService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends message with normalized numbers and returns success', async () => {
    const mockPost = vi.fn().mockResolvedValueOnce({ data: { status: 'submitted', messageId: 'msg-1' }, status: 200 });
    mockedAxios.create.mockReturnValueOnce({ post: mockPost, get: vi.fn(), defaults: { headers: {} } });

    const service = new GupshupService({ apiKey: 'key', appName: 'app', sourceNumber: '+55 11 99999-8888' });
    const result = await service.sendTextMessage({ to: '(21) 93618-7141', message: 'Ola' });

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ status: 'success', messageId: 'msg-1' }));
  });

  it('returns error when response has non-submitted status', async () => {
    const mockPost = vi.fn().mockResolvedValueOnce({ data: { status: 'failed', message: 'invalid' }, status: 200 });
    mockedAxios.create.mockReturnValueOnce({ post: mockPost, get: vi.fn(), defaults: { headers: {} } });

    const service = new GupshupService({ apiKey: 'key', appName: 'app', sourceNumber: '5511999998888' });
    const result = await service.sendTextMessage({ to: '21999998888', message: 'Ola' });

    expect(result.status).toBe('error');
  });

  it('returns error on axios throw', async () => {
    const mockPost = vi.fn().mockRejectedValueOnce({ response: { status: 400, data: { error: 'invalid' } }, message: 'x' });
    mockedAxios.create.mockReturnValueOnce({ post: mockPost, get: vi.fn(), defaults: { headers: {} } });

    const service = new GupshupService({ apiKey: 'key', appName: 'app', sourceNumber: '5511999998888' });
    const result = await service.sendTextMessage({ to: '21999998888', message: 'Ola' });

    expect(result.status).toBe('error');
  });

  it('sends quick reply message and handles error path', async () => {
    const mockPost = vi.fn()
      .mockResolvedValueOnce({ data: { status: 'submitted', messageId: 'qr-1' }, status: 200 })
      .mockResolvedValueOnce({ data: { status: 'failed', message: 'rejected' }, status: 200 })
      .mockRejectedValueOnce({ response: { status: 400, data: { error: 'qr-fail' } }, message: 'fail' });
    mockedAxios.create.mockReturnValue({ post: mockPost, get: vi.fn(), defaults: { headers: {} } });

    const service = new GupshupService({ apiKey: 'key', appName: 'app', sourceNumber: '5511999998888' });

    const ok = await service.sendQuickReplyMessage({ to: '21999998888', body: 'Confirma?', options: [{ title: 'Sim' }] });
    expect(ok.status).toBe('success');
    expect(ok.messageId).toBe('qr-1');

    const err = await service.sendQuickReplyMessage({ to: '21999998888', body: 'Confirma?', footer: 'rodape', msgId: 'mid-1', options: [{ title: 'Nao', postbackText: 'nao' }] });
    expect(err.status).toBe('error');

    const thrown = await service.sendQuickReplyMessage({ to: '21999998888', body: 'x', options: [] });
    expect(thrown.status).toBe('error');
  });

  it('sends list message and handles error paths', async () => {
    const mockPost = vi.fn()
      .mockResolvedValueOnce({ data: { status: 'submitted', messageId: 'list-1' }, status: 200 })
      .mockResolvedValueOnce({ data: { status: 'failed' }, status: 200 })
      .mockRejectedValueOnce({ response: { status: 400, data: { message: 'bad-list' } }, message: 'fail' });
    mockedAxios.create.mockReturnValue({ post: mockPost, get: vi.fn(), defaults: { headers: {} } });

    const service = new GupshupService({ apiKey: 'key', appName: 'app', sourceNumber: '5511999998888' });

    const ok = await service.sendListMessage({ to: '21999998888', body: 'Escolha', options: [{ title: 'Op1', description: 'desc', postbackText: 'op1' }] });
    expect(ok.status).toBe('success');

    const err = await service.sendListMessage({ to: '21999998888', body: 'Escolha', buttonTitle: 'Abrir', sectionTitle: 'Seção', options: [] });
    expect(err.status).toBe('error');

    const thrown = await service.sendListMessage({ to: '21999998888', body: 'x', options: [] });
    expect(thrown.status).toBe('error');
  });

  it('sends template message and handles error paths', async () => {
    const mockPost = vi.fn()
      .mockResolvedValueOnce({ data: { status: 'submitted', messageId: 'tpl-1' }, status: 200 })
      .mockResolvedValueOnce({ data: { status: 'failed', message: 'bad-tpl' }, status: 200 })
      .mockRejectedValueOnce({ response: { status: 500, data: { message: 'server-err' } }, message: 'fail' });
    mockedAxios.create.mockReturnValue({ post: mockPost, get: vi.fn(), defaults: { headers: {} } });

    const service = new GupshupService({ apiKey: 'key', appName: 'app', sourceNumber: '5511999998888' });

    const ok = await service.sendTemplateMessage({ to: '21999998888', templateId: 'tpl-id', params: ['p1', 'p2'] });
    expect(ok.status).toBe('success');

    const err = await service.sendTemplateMessage({ to: '21999998888', templateId: 'tpl-id', params: [] });
    expect(err.status).toBe('error');

    const thrown = await service.sendTemplateMessage({ to: '21999998888', templateId: 'tpl-id', params: [] });
    expect(thrown.status).toBe('error');
  });

  it('getMessageStatus returns data and throws on error', async () => {
    const mockGet = vi.fn()
      .mockResolvedValueOnce({ data: { status: 'SENT' } })
      .mockRejectedValueOnce({ response: { data: { message: 'not found' } }, message: 'fail' });
    mockedAxios.create.mockReturnValue({ post: vi.fn(), get: mockGet, defaults: { headers: {} } });

    const service = new GupshupService({ apiKey: 'key', appName: 'app', sourceNumber: '5511999998888' });

    const result = await service.getMessageStatus('msg-1');
    expect(result).toEqual({ status: 'SENT' });

    await expect(service.getMessageStatus('missing')).rejects.toThrow('not found');
  });

  it('getMediaUrl returns url from various response shapes and null when all fail', async () => {
    const mockGet = vi.fn();
    mockedAxios.create.mockReturnValue({ post: vi.fn(), get: mockGet, defaults: { headers: { apikey: 'key' } } });
    (mockedAxios as any).get = mockGet;

    const service = new GupshupService({ apiKey: 'key', appName: 'app', sourceNumber: '5511999998888' });

    // All endpoints fail → returns null
    mockGet.mockRejectedValue({ response: { status: 404 }, message: 'not found' });
    const nullResult = await service.getMediaUrl('media-id-1');
    expect(nullResult).toBeNull();

    // First endpoint (/media/...) returns url in data.url (client.get path)
    mockGet.mockResolvedValueOnce({ data: { url: 'https://example.com/media.jpg' }, status: 200 });
    const urlResult = await service.getMediaUrl('media-id-2');
    expect(urlResult).toEqual({ url: 'https://example.com/media.jpg' });

    // First endpoint fails, second endpoint (https://...) returns media.url shape
    mockGet
      .mockRejectedValueOnce({ response: { status: 404 }, message: 'not found' }) // /media/... fails
      .mockResolvedValueOnce({ data: { media: { url: 'https://media.example.com/file.jpg' } }, status: 200 }); // https://api.gupshup.io/... succeeds
    const mediaUrlResult = await service.getMediaUrl('media-id-3');
    expect(mediaUrlResult).toEqual({ url: 'https://media.example.com/file.jpg' });

    // First endpoint fails, second returns string URL
    mockGet
      .mockRejectedValueOnce({ response: { status: 404 }, message: 'not found' })
      .mockResolvedValueOnce({ data: 'https://direct.example.com/file.jpg', status: 200 });
    const stringUrlResult = await service.getMediaUrl('media-id-4');
    expect(stringUrlResult).toEqual({ url: 'https://direct.example.com/file.jpg' });

    // First endpoint succeeds but has no url → logs no URL found, continues; second also no url; third no url → returns null
    mockGet
      .mockResolvedValueOnce({ data: { noUrl: true }, status: 200 }) // /media/... - no url
      .mockResolvedValueOnce({ data: { noUrl: true }, status: 200 }) // https://api.gupshup.io - no url
      .mockResolvedValueOnce({ data: { noUrl: true }, status: 200 }); // https://media.gupshup.io - no url
    const noUrlResult = await service.getMediaUrl('media-id-5');
    expect(noUrlResult).toBeNull();
  });
});
