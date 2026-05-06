import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';
require('dotenv').config();
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

async function callGroq(messages: { role: string; content: string }[]): Promise<string> {
  const response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.4,
      messages,
    }),
  });
  if (!response.ok) {
    const err = await response.json() as any;
    throw new Error(err?.error?.message || 'Erro na API Groq');
  }
  const data = await response.json() as any;
  return String(data.choices?.[0]?.message?.content || '').trim();
}

export default async function aiQuestionnaireRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // GET /care/ai-questionnaire/:appointmentId — busca questionário existente
  app.get('/:appointmentId', async (request, reply) => {
    const { appointmentId } = request.params as { appointmentId: string };

    const existing = await prisma.aiQuestionnaire.findUnique({
      where: { appointmentId },
    });

    if (!existing) {
      return reply.code(404).send({ error: 'Questionário não encontrado' });
    }

    return reply.send({
      id: existing.id,
      appointmentId: existing.appointmentId,
      patientComplaints: existing.patientComplaints,
      questions: existing.questions,
      answers: existing.answers,
      generatedAt: existing.generatedAt,
      savedAt: existing.savedAt,
    });
  });

  // POST /care/ai-questionnaire/generate — gera perguntas via Groq
  app.post('/generate', {
    schema: {
      body: {
        type: 'object',
        required: ['appointmentId'],
        properties: {
          appointmentId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    if (!GROQ_API_KEY) {
      return reply.code(503).send({ error: 'GROQ_API_KEY não configurado.' });
    }

    const { appointmentId } = request.body as { appointmentId: string };

    // Busca patientComplaints no preSchedulingFlow
    const flow = await prisma.preSchedulingFlow.findFirst({
      where: { appointmentId },
      select: { patientComplaints: true },
    });

    const patientComplaints = flow?.patientComplaints || '';

    // Se já existe questionário gerado, retorna ele
    const existing = await prisma.aiQuestionnaire.findUnique({
      where: { appointmentId },
    });
    if (existing) {
      return reply.send({
        questions: existing.questions,
        answers: existing.answers,
        patientComplaints: existing.patientComplaints,
        alreadyGenerated: true,
      });
    }

    const systemPrompt = `Você é um assistente médico clínico especializado em anamnese.
Com base na queixa principal do paciente, gere de 5 a 7 perguntas clínicas objetivas para o médico fazer ao paciente durante a teleconsulta.

Regras:
- As perguntas devem aprofundar a queixa principal (localização, intensidade, duração, fatores de melhora/piora, sintomas associados, histórico)
- Escreva em português brasileiro, de forma clara e simples
- Para perguntas que admitem respostas predefinidas (ex.: localização, intensidade, frequência, sim/não), inclua um campo "options" com 3 a 5 opções curtas; a última opção deve ser sempre "Outra"
- Para perguntas abertas (ex.: descrição livre de sintomas), omita o campo "options"
- Retorne SOMENTE um array JSON com objetos no formato: [{"id": 1, "question": "...", "options": ["Op1", "Op2", "Outra"]}, {"id": 2, "question": "..."}]
- Não inclua explicações, markdown ou blocos de código — apenas o JSON puro`;

    const userPrompt = patientComplaints
      ? `Queixa principal do paciente: "${patientComplaints}"`
      : 'O paciente não informou queixa principal. Gere perguntas gerais de anamnese.';

    let questions: { id: number; question: string; options?: string[] }[] = [];
    try {
      const raw = await callGroq([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ]);

      // Extrai o JSON mesmo se vier com texto ao redor
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('Resposta da IA não contém JSON válido');
      questions = JSON.parse(jsonMatch[0]);
    } catch (err: any) {
      return reply.code(502).send({ error: err?.message || 'Falha ao gerar perguntas' });
    }

    // Salva no banco
    await prisma.aiQuestionnaire.create({
      data: {
        appointmentId,
        patientComplaints: patientComplaints || null,
        questions,
      },
    });

    return reply.send({ questions, patientComplaints });
  });

  // POST /care/ai-questionnaire/save-answers — salva respostas do médico
  app.post('/save-answers', {
    schema: {
      body: {
        type: 'object',
        required: ['appointmentId', 'answers'],
        properties: {
          appointmentId: { type: 'string' },
          answers: { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    const { appointmentId, answers } = request.body as {
      appointmentId: string;
      answers: Record<string, string>;
    };

    const updated = await prisma.aiQuestionnaire.update({
      where: { appointmentId },
      data: {
        answers,
        savedAt: new Date(),
      },
    });

    return reply.send({ message: 'Respostas salvas com sucesso', savedAt: updated.savedAt });
  });
}
