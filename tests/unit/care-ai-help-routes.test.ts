import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/modules/care/lib/saudy-knowledge', () => ({
  SAUDY_KNOWLEDGE: 'CONHECIMENTO_MOCK',
}));

vi.mock('../../src/modules/care/lib/code-search', () => ({
  searchCodebase: vi.fn(),
  reindexCodebaseFromGitHub: vi.fn(),
}));

vi.mock('../../src/lib/prisma', () => ({
  default: {
    knowledgeSuggestion: { create: vi.fn() },
  },
}));

import { searchCodebase, reindexCodebaseFromGitHub } from '../../src/modules/care/lib/code-search';
import prismaModule from '../../src/lib/prisma';

const mockedSearch = searchCodebase as any;
const mockedReindex = reindexCodebaseFromGitHub as any;
const prisma = (prismaModule as any);

const MESSAGES = [{ role: 'user', content: 'Como criar agendamento?' }];

function buildSseStream(chunks: string[]) {
  const body = chunks.join('');
  const encoder = new TextEncoder();
  const encoded = encoder.encode(body);
  return new ReadableStream({
    start(controller) { controller.enqueue(encoded); controller.close(); },
  });
}

async function buildApp(role = 'USER') {
  const { default: aiHelpRoutes } = await import('../../src/modules/care/routes/ai-help');
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function (this: any) {
    this.user = { id: 'u-1', role };
  });
  await app.register(aiHelpRoutes, { prefix: '/help' });
  return app;
}

describe('care ai-help routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('GROQ_API_KEY', 'test-key');
  });

  it('returns 400 when messages is missing or empty', async () => {
    const app = await buildApp();
    let res = await app.inject({ method: 'POST', url: '/help/chat', payload: {} });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'POST', url: '/help/chat', payload: { messages: [] } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('streams first-pass answer directly when knowledge base covers the question', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Vá até Agendamentos e clique em Novo.' } }] }),
    }));

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/help/chat', payload: { messages: MESSAGES } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Vá até Agendamentos');
    expect(res.body).toContain('[DONE]');
    await app.close();
  });

  it('falls back to code search when first pass returns [SEM_CONTEXTO]', async () => {
    const longChunk = 'Para agendar uma consulta, acesse o menu principal e clique em Agendamentos, depois em Novo Agendamento.';
    const streamBody = buildSseStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: longChunk } }] })}\n\n`,
      `data: [DONE]\n\n`,
    ]);

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: '[SEM_CONTEXTO]' } }] }) })
      .mockResolvedValueOnce({ ok: true, body: streamBody }),
    );
    mockedSearch.mockResolvedValue('// repo/file.ts\nconst x = 1;');
    prisma.knowledgeSuggestion.create.mockResolvedValue({});

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/help/chat', payload: { messages: MESSAGES } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('_Buscando no sistema..._');
    expect(res.body).toContain('Para agendar uma consulta');
    expect(res.body).toContain('[DONE]');
    expect(prisma.knowledgeSuggestion.create).toHaveBeenCalled();
    await app.close();
  });

  it('returns fallback message when code search finds nothing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '[SEM_CONTEXTO]' } }] }),
    }));
    mockedSearch.mockResolvedValue('');

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/help/chat', payload: { messages: MESSAGES } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Não encontrei informações suficientes');
    await app.close();
  });

  it('emits error event when groq throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network fail')));

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/help/chat', payload: { messages: MESSAGES } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('network fail');
    await app.close();
  });

  it('reindex returns 403 for non-admin', async () => {
    const app = await buildApp('USER');
    const res = await app.inject({ method: 'POST', url: '/help/reindex' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('reindex calls reindexCodebaseFromGitHub for admin and returns result', async () => {
    mockedReindex.mockResolvedValue({ repos: 2, files: 10, chunks: 50 });
    const app = await buildApp('ADMIN');
    const res = await app.inject({ method: 'POST', url: '/help/reindex' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, repos: 2, files: 10, chunks: 50 });
    await app.close();
  });

  it('reindex returns 500 when reindexCodebaseFromGitHub throws', async () => {
    mockedReindex.mockRejectedValue(new Error('github fail'));
    const app = await buildApp('ADMIN');
    const res = await app.inject({ method: 'POST', url: '/help/reindex' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('github fail');
    await app.close();
  });
});
