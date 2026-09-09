import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import aiQuestionnaireRoutes from '../../src/modules/care/routes/ai-questionnaire';
import prisma from '../../src/modules/care/lib/prisma';

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    aiQuestionnaire: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    preSchedulingFlow: {
      findFirst: vi.fn(),
    },
  },
}));

const mockedPrisma = prisma as any;

async function buildApp(opts?: { unauthorized?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1' };
  });

  await app.register(aiQuestionnaireRoutes, { prefix: '/ai-questionnaire' });
  return app;
}

describe('care ai-questionnaire routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('GROQ_API_KEY', 'test-key');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('rejects unauthorized requests', async () => {
    const app = await buildApp({ unauthorized: true });
    const res = await app.inject({ method: 'GET', url: '/ai-questionnaire/appt-1' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('GET returns 404 when no questionnaire exists', async () => {
    mockedPrisma.aiQuestionnaire.findUnique.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/ai-questionnaire/appt-1' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET returns the existing questionnaire', async () => {
    mockedPrisma.aiQuestionnaire.findUnique.mockResolvedValue({
      id: 'q-1',
      appointmentId: 'appt-1',
      patientComplaints: 'Dor de cabeça',
      questions: [{ id: 1, question: 'Há quanto tempo?' }],
      answers: null,
      generatedAt: new Date('2024-01-01'),
      savedAt: null,
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/ai-questionnaire/appt-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().patientComplaints).toBe('Dor de cabeça');
    await app.close();
  });

  it('POST /generate returns existing questionnaire without calling Groq', async () => {
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValue({ patientComplaints: 'Febre' });
    mockedPrisma.aiQuestionnaire.findUnique.mockResolvedValue({
      questions: [{ id: 1, question: 'Desde quando?' }],
      answers: null,
      patientComplaints: 'Febre',
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/ai-questionnaire/generate', payload: { appointmentId: 'appt-1' } });

    expect(res.statusCode).toBe(200);
    expect(res.json().alreadyGenerated).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it('POST /generate calls Groq, parses questions and saves them', async () => {
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValue({ patientComplaints: 'Dor no peito' });
    mockedPrisma.aiQuestionnaire.findUnique.mockResolvedValue(null);
    mockedPrisma.aiQuestionnaire.create.mockResolvedValue({});

    const groqQuestions = [{ id: 1, question: 'Onde dói?', options: ['Peito', 'Costas', 'Outra'] }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: `Aqui estão: ${JSON.stringify(groqQuestions)}` } }] }),
    }));

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/ai-questionnaire/generate', payload: { appointmentId: 'appt-1' } });

    expect(res.statusCode).toBe(200);
    expect(res.json().questions).toEqual(groqQuestions);
    expect(mockedPrisma.aiQuestionnaire.create).toHaveBeenCalledWith({
      data: { appointmentId: 'appt-1', patientComplaints: 'Dor no peito', questions: groqQuestions },
    });
    await app.close();
  });

  it('POST /generate returns 502 when Groq response has no valid JSON', async () => {
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValue(null);
    mockedPrisma.aiQuestionnaire.findUnique.mockResolvedValue(null);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'não é json' } }] }),
    }));

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/ai-questionnaire/generate', payload: { appointmentId: 'appt-1' } });

    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it('POST /generate returns 502 when Groq call fails', async () => {
    mockedPrisma.preSchedulingFlow.findFirst.mockResolvedValue(null);
    mockedPrisma.aiQuestionnaire.findUnique.mockResolvedValue(null);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: 'quota excedida' } }),
    }));

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/ai-questionnaire/generate', payload: { appointmentId: 'appt-1' } });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('quota excedida');
    await app.close();
  });

  it('POST /save-answers persists answers and returns savedAt', async () => {
    const savedAt = new Date('2024-02-01');
    mockedPrisma.aiQuestionnaire.update.mockResolvedValue({ savedAt });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/ai-questionnaire/save-answers',
      payload: { appointmentId: 'appt-1', answers: { '1': 'Sim' } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().message).toMatch(/salvas/);
    expect(mockedPrisma.aiQuestionnaire.update).toHaveBeenCalledWith({
      where: { appointmentId: 'appt-1' },
      data: { answers: { '1': 'Sim' }, savedAt: expect.any(Date) },
    });
    await app.close();
  });
});
