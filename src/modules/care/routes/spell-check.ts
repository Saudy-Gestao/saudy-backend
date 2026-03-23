import { FastifyInstance } from 'fastify';
require('dotenv').config();

const GROQ_API_KEY = process.env.GROQ_API_KEY;

interface LLMProvider {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function getProvider(): LLMProvider | null {
  // Groq tem plano gratuito generoso — prioridade
  if (GROQ_API_KEY) {
    return { baseUrl: 'https://api.groq.com/openai/v1', apiKey: GROQ_API_KEY, model: 'llama-3.3-70b-versatile' };
  }

  return null;
}

export default async function spellCheckRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  /**
   * POST /care/spell-check
   * Corrige ortografia e gramática do HTML de um laudo usando GPT-4o-mini.
   * Preserva todas as tags HTML e apenas corrige erros de escrita.
   */
  app.post('/', {
    schema: {
      summary: 'Spell-check and grammar correction for report HTML content',
      tags: ['Reports'],
      body: {
        type: 'object',
        required: ['html'],
        properties: {
          html: { type: 'string', description: 'HTML content to correct' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            correctedHtml: { type: 'string' },
          },
        },
        400: { type: 'object' },
        502: { type: 'object' },
        503: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const provider = getProvider();
    if (!provider) {
      return reply.code(503).send({
        error: 'Serviço de correção ortográfica não configurado. Adicione GROQ_API_KEY ao arquivo .env do backend.',
      });
    }

    const { html } = request.body as { html: string };

    if (!html || html.trim().length === 0) {
      return reply.code(400).send({ error: 'Texto vazio.' });
    }

    try {
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model: provider.model,
          temperature: 0.1,
          messages: [
            {
              role: 'system',
              content: `Você é um revisor especializado em textos médicos em português brasileiro.
Corrija APENAS erros ortográficos e gramaticais no texto fornecido.

Regras obrigatórias:
- Preserve TODOS os elementos HTML (tags, atributos, estrutura) exatamente como estão
- Corrija somente palavras com erros claros de ortografia ou gramática
- Mantenha terminologia médica técnica intacta (podem parecer estranhas mas são corretas)
- Não altere abreviações médicas
- Não reescreva frases — apenas corrija erros pontuais de escrita
- Retorne APENAS o HTML corrigido, sem explicações, sem markdown, sem blocos de código`,
            },
            {
              role: 'user',
              content: html,
            },
          ],
        }),
      });

      if (!response.ok) {
        const err = await response.json() as any;
        const message = err?.error?.message || JSON.stringify(err) || 'Erro na API de correção ortográfica.';
        console.error('[spell-check] API error:', message);
        return reply.code(502).send({ error: message });
      }

      const data = await response.json() as any;
      const correctedHtml = data.choices?.[0]?.message?.content?.trim() || html;

      return { correctedHtml };
    } catch (err: any) {
      return reply.code(502).send({
        error: err?.message || 'Não foi possível conectar ao serviço de correção.',
      });
    }
  });
}
