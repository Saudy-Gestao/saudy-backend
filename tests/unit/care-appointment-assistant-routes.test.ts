import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('care appointment assistant routes', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn());
  });

  it('parses an appointment request into a normalized draft without persisting it', async () => {
    const mockedFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              patientName: 'Marina Freitas',
              procedureNames: ['Integração Sensorial'],
              professionalName: 'Dr. Thiago Prado',
              date: '2026-09-14',
              time: '10:15',
              modality: 'Presencial',
              recurrenceOccurrences: 4,
              recurrenceIntervalWeeks: 1,
              simultaneous: false,
            }),
          },
        }],
      }),
    });

    const { default: appointmentAssistantRoutes } = await import('../../src/modules/care/routes/appointment-assistant');
    const app = Fastify();
    app.decorateRequest('user', null);
    app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
      this.user = { id: 'u-1' };
    });
    await app.register(appointmentAssistantRoutes, { prefix: '/assistant' });

    const response = await app.inject({
      method: 'POST',
      url: '/assistant/parse',
      payload: {
        prompt: 'Agendar Marina Freitas para Integração Sensorial amanhã às 10:15 com o Dr. Thiago Prado',
        currentDate: '2026-09-13',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().draft).toEqual(expect.objectContaining({
      patientName: 'Marina Freitas',
      procedureNames: ['Integração Sensorial'],
      date: '2026-09-14',
      time: '10:15',
      recurrenceOccurrences: 4,
    }));
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('rejects empty prompts before calling the AI provider', async () => {
    const mockedFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const { default: appointmentAssistantRoutes } = await import('../../src/modules/care/routes/appointment-assistant');
    const app = Fastify();
    app.decorateRequest('user', null);
    app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
      this.user = { id: 'u-1' };
    });
    await app.register(appointmentAssistantRoutes, { prefix: '/assistant' });

    const response = await app.inject({ method: 'POST', url: '/assistant/parse', payload: { prompt: '  ' } });

    expect(response.statusCode).toBe(400);
    expect(mockedFetch).not.toHaveBeenCalled();
    await app.close();
  });

  it('normalizes weekday expressions and preserves first-available intent', async () => {
    const mockedFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              patientName: 'Lucas Coelho',
              procedureNames: ['terapia'],
              professionalName: null,
              professionalPreference: 'first_available',
              date: '2026-09-14',
              time: '15:00',
            }),
          },
        }],
      }),
    });

    const { default: appointmentAssistantRoutes } = await import('../../src/modules/care/routes/appointment-assistant');
    const app = Fastify();
    app.decorateRequest('user', null);
    app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
      this.user = { id: 'u-1' };
    });
    await app.register(appointmentAssistantRoutes, { prefix: '/assistant' });

    const response = await app.inject({
      method: 'POST',
      url: '/assistant/parse',
      payload: {
        prompt: 'Agendar Lucas Coelho para terapia, na quarta-feira que vem às 15h com o primeiro médico disponível',
        currentDate: '2026-09-13',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().draft).toEqual(expect.objectContaining({
      date: '2026-09-16',
      professionalPreference: 'first_available',
      professionalName: null,
    }));
    await app.close();
  });

  it('requires authentication', async () => {
    const { default: appointmentAssistantRoutes } = await import('../../src/modules/care/routes/appointment-assistant');
    const app = Fastify();
    app.decorateRequest('user', null);
    app.decorateRequest('jwtVerify', async function jwtVerify() {
      throw new Error('unauthorized');
    });
    await app.register(appointmentAssistantRoutes, { prefix: '/assistant' });

    const response = await app.inject({ method: 'POST', url: '/assistant/parse', payload: { prompt: 'Agendar consulta' } });

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
