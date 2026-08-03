import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { GupshupService, MetaMessagingService as GupshupV3Service, createMessagingService } from '../../src/modules/care/lib/messaging';

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

const APP_ID = 'app-uuid';
const BEARER = 'bearer-token';
const V3_URL = `https://graph.facebook.com/v21.0/${APP_ID}/messages`;

describe('GupshupV3Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends text message and normalizes 11-digit number', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { messages: [{ id: 'm1' }] } });
    const service = new GupshupV3Service({ bearerToken: BEARER, appId: APP_ID, sourceNumber: '5511999990000' });

    const res = await service.sendTextMessage({ to: '11988887777', message: 'Oi' });
    expect(res).toEqual({ status: 'success', messageId: 'm1' });
    expect(mockedAxios.post).toHaveBeenCalledWith(V3_URL, expect.any(Object), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${BEARER}` }),
    }));
  });

  it('adds country code 55 to 10-digit numbers', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { messages: [{ id: 'm2' }] } });
    const service = new GupshupV3Service({ bearerToken: BEARER, appId: APP_ID, sourceNumber: '5511999990000' });

    await service.sendTextMessage({ to: '1188887777', message: 'Oi' });
    const body = mockedAxios.post.mock.calls[0][1];
    expect(body.to).toBe('551188887777');
  });

  it('keeps numbers already with country code 55', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { messages: [{ id: 'm3' }] } });
    const service = new GupshupV3Service({ bearerToken: BEARER, appId: APP_ID, sourceNumber: '5511999990000' });

    await service.sendTextMessage({ to: '5511988887777', message: 'Oi' });
    const body = mockedAxios.post.mock.calls[0][1];
    expect(body.to).toBe('5511988887777');
    expect(body.to).not.toBe('555511988887777');
  });

  it('returns success when meta response has messages array', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { messages: [{ id: 'x1' }], messaging_product: 'whatsapp' } });
    const service = new GupshupV3Service({ bearerToken: BEARER, appId: APP_ID, sourceNumber: '5511999990000' });

    const res = await service.sendTextMessage({ to: '5511988887777', message: 'Oi' });
    expect(res.status).toBe('success');
    expect(res.messageId).toBe('x1');
  });

  it('returns error when response has no message id or submitted status', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { status: 'queued', error: { message: 'text-not-submitted' } } });
    const service = new GupshupV3Service({ bearerToken: BEARER, appId: APP_ID, sourceNumber: '5511999990000' });

    const res = await service.sendTextMessage({ to: '5511988887777', message: 'Oi' });
    expect(res.status).toBe('error');
  });

  it('returns error on axios throw', async () => {
    mockedAxios.post.mockRejectedValueOnce({ response: { status: 401, data: { error: { message: 'unauthorized' } } }, message: 'x' });
    const service = new GupshupV3Service({ bearerToken: BEARER, appId: APP_ID, sourceNumber: '5511999990000' });

    const res = await service.sendTextMessage({ to: '5511988887777', message: 'Oi' });
    expect(res.status).toBe('error');
    expect(String(res.error)).toContain('unauthorized');
  });

  it('sends quick reply message', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { messages: [{ id: 'q1' }] } });
    const service = new GupshupV3Service({ bearerToken: BEARER, appId: APP_ID, sourceNumber: '5511999990000' });

    const res = await service.sendQuickReplyMessage({
      to: '5511988887777',
      body: 'Confirmar?',
      options: [{ title: 'Sim', postbackText: 'SIM' }, { title: 'Não', postbackText: 'NAO' }],
    });
    expect(res.status).toBe('success');
    const body = mockedAxios.post.mock.calls[0][1];
    expect(body.type).toBe('interactive');
    expect(body.interactive.type).toBe('button');
  });

  it('sends list message', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { messages: [{ id: 'l1' }] } });
    const service = new GupshupV3Service({ bearerToken: BEARER, appId: APP_ID, sourceNumber: '5511999990000' });

    const res = await service.sendListMessage({
      to: '5511988887777',
      body: 'Escolha uma opção',
      options: [{ title: 'Opção 1', postbackText: '1' }, { title: 'Opção 2', postbackText: '2' }],
    });
    expect(res.status).toBe('success');
    const body = mockedAxios.post.mock.calls[0][1];
    expect(body.interactive.type).toBe('list');
  });

  it('sends template message', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { messages: [{ id: 't1' }] } });
    const service = new GupshupV3Service({ bearerToken: BEARER, appId: APP_ID, sourceNumber: '5511999990000' });

    const res = await service.sendTemplateMessage({ to: '5511988887777', templateId: 'tpl-1', params: ['A', 'B'] });
    expect(res.status).toBe('success');
    const body = mockedAxios.post.mock.calls[0][1];
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('tpl-1');
  });

  it('sends flow message', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { messages: [{ id: 'f1' }] } });
    const service = new GupshupV3Service({ bearerToken: BEARER, appId: APP_ID, sourceNumber: '5511999990000' });

    const res = await service.sendFlowMessage({
      to: '5511988887777',
      flowId: 'flow-123',
      flowToken: 'tok',
      bodyText: 'Agendar',
      ctaText: 'Abrir',
    });
    expect(res.status).toBe('success');
    const body = mockedAxios.post.mock.calls[0][1];
    expect(body.interactive.type).toBe('flow');
    expect(body.interactive.action.parameters.flow_id).toBe('flow-123');
  });

  it('getMediaUrl returns url on success', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { url: 'https://media/file.jpg' } });
    const service = new GupshupV3Service({ bearerToken: BEARER, appId: APP_ID, sourceNumber: '5511999990000' });

    const media = await service.getMediaUrl('media-id-1');
    expect(media).toEqual({ url: 'https://media/file.jpg' });
  });

  it('getMediaUrl returns null on failure', async () => {
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 404 } });
    const service = new GupshupV3Service({ bearerToken: BEARER, appId: APP_ID, sourceNumber: '5511999990000' });

    const media = await service.getMediaUrl('missing-id');
    expect(media).toBeNull();
  });
});

describe('createMessagingService factory', () => {
  it('creates GupshupService from accountSid/authToken shape', async () => {
    mockedAxios.create.mockReturnValueOnce({ post: vi.fn().mockResolvedValueOnce({ data: { status: 'submitted', messageId: 'x1' } }) } as any);
    const service = createMessagingService({ accountSid: 'sk_key', authToken: 'myapp', fromNumber: '5511999990000' });

    const res = await service.sendTextMessage({ to: '5511988887777', message: 'Oi' });
    expect(res.status).toBe('success');
  });
});

describe('GupshupService (legacy v2 — kept for reference)', () => {
  it('is still exported as a named class', () => {
    expect(GupshupService).toBeDefined();
    expect(typeof GupshupService).toBe('function');
  });
});
