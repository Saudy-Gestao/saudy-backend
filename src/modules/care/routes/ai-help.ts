import { FastifyInstance } from 'fastify';
import { SAUDY_KNOWLEDGE } from '../lib/saudy-knowledge';
import { searchCodebase, reindexCodebaseFromGitHub } from '../lib/code-search';
import prismaModule from '../../../lib/prisma';

const prisma: any = (prismaModule as any)?.default ?? prismaModule;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.3-70b-versatile';

const SYSTEM_CHECK = SAUDY_KNOWLEDGE + `\n\n---\nINSTRUÇÃO: Se a pergunta não puder ser respondida com as informações acima, responda SOMENTE com a palavra [SEM_CONTEXTO]. Caso contrário, responda normalmente em português.`;

const SYSTEM_CODE = (codeContext: string) =>
  `${SAUDY_KNOWLEDGE}\n\nCONTEXTO DO CÓDIGO-FONTE DO SAUDY:\n\`\`\`\n${codeContext}\n\`\`\`\n\nREGRAS:\n- Você é um assistente de suporte para USUÁRIOS FINAIS (recepcionistas, médicos, atendentes). NÃO para desenvolvedores.\n- NUNCA mencione nomes técnicos: variáveis, enums, tabelas de banco, tipos TypeScript, nomes de arquivos ou rotas.\n- Traduza termos técnicos para linguagem do dia a dia.\n- Foque no fluxo operacional: qual tela, qual botão, em que ordem.\n- Use passo a passo numerado quando for um processo.\n- Responda em português.`;

interface ChatMessage { role: 'user' | 'assistant'; content: string }

async function groqComplete(systemPrompt: string, messages: ChatMessage[]): Promise<string> {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY não configurado');
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model: MODEL, temperature: 0.4, max_tokens: 1500, messages: [{ role: 'system', content: systemPrompt }, ...messages] }),
  });
  if (!res.ok) throw new Error(`Groq error: ${res.status}`);
  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

async function groqStream(systemPrompt: string, messages: ChatMessage[], onDelta: (text: string) => void): Promise<string> {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY não configurado');
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model: MODEL, temperature: 0.4, max_tokens: 1500, stream: true, messages: [{ role: 'system', content: systemPrompt }, ...messages] }),
  });
  if (!res.ok) throw new Error(`Groq stream error: ${res.status}`);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') continue;
      try {
        const parsed = JSON.parse(raw);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) { fullText += delta; onDelta(delta); }
      } catch {}
    }
  }

  return fullText;
}

export default async function aiHelpRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    try { await request.jwtVerify(); } catch { reply.code(401).send({ error: 'Unauthorized' }); }
  });

  // POST /care/help/chat — SSE streaming chat
  app.post('/chat', async (request, reply) => {
    if (!GROQ_API_KEY) return reply.code(503).send({ error: 'Serviço de IA não configurado.' });

    const { messages } = request.body as { messages: ChatMessage[] };
    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.code(400).send({ error: 'messages é obrigatório' });
    }

    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

    const origin = request.headers.origin || '*';
    reply.raw.setHeader('Access-Control-Allow-Origin', origin);
    reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.hijack();

    const write = (data: object) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
      // Pass 1: check if SAUDY_KNOWLEDGE covers the question
      const firstResponse = await groqComplete(SYSTEM_CHECK, messages);

      if (firstResponse.trim().startsWith('[SEM_CONTEXTO]')) {
        // Search codebase for more context
        write({ text: '_Buscando no sistema..._\n\n' });
        const codeContext = await searchCodebase(lastUserMessage);

        if (!codeContext) {
          write({ text: 'Não encontrei informações suficientes sobre isso. Entre em contato com o suporte Saudy para mais detalhes.' });
          reply.raw.write('data: [DONE]\n\n');
          return reply.raw.end();
        }

        // Pass 2: stream with code context
        const secondResponse = await groqStream(SYSTEM_CODE(codeContext), messages, (delta) => write({ text: delta }));

        // Save suggestion for admin review
        if (secondResponse.trim().length > 50) {
          await prisma.knowledgeSuggestion.create({
            data: { question: lastUserMessage, answer: secondResponse.trim(), codeContext },
          });
          write({ newSuggestion: true });
        }
      } else {
        // Stream the first response as-is
        write({ text: firstResponse });
      }

      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    } catch (err: any) {
      write({ error: err?.message || 'Erro interno' });
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    }
  });

  // POST /care/help/reindex — admin triggers GitHub reindex
  app.post('/reindex', async (request, reply) => {
    // Only allow admin role
    const user = (request as any).user;
    if (user?.role !== 'ADMIN' && user?.role !== 'SUPERADMIN') {
      return reply.code(403).send({ error: 'Acesso negado' });
    }
    try {
      const result = await reindexCodebaseFromGitHub();
      return reply.send({ ok: true, ...result });
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message || 'Falha ao reindexar' });
    }
  });
}
