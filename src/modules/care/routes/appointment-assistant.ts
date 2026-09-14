import { FastifyInstance } from 'fastify';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const CLINIC_TIME_ZONE = process.env.APP_TIMEZONE || 'America/Sao_Paulo';

type AssistantPeriod = 'Manhã' | 'Tarde' | 'Noite';
type AssistantModality = 'Presencial' | 'Teleconsulta';
type AssistantProfessionalPreference = 'first_available';

export interface AppointmentAssistantDraft {
  patientName: string | null;
  patientCpf: string | null;
  procedureNames: string[];
  professionalName: string | null;
  professionalPreference: AssistantProfessionalPreference | null;
  date: string | null;
  time: string | null;
  period: AssistantPeriod | null;
  modality: AssistantModality | null;
  insuranceName: string | null;
  recurrenceOccurrences: number | null;
  recurrenceIntervalWeeks: number | null;
  simultaneous: boolean | null;
  observations: string | null;
}

const cleanText = (value: unknown, maxLength = 180): string | null => {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
};

const normalizeComparableText = (value: unknown): string => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[-_]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const resolveWeekdayFromPrompt = (prompt: string, currentDate: string): string | null => {
  if (/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(prompt)) return null;
  const normalizedPrompt = normalizeComparableText(prompt);
  const weekdays = [
    { names: ['domingo'], day: 0 },
    { names: ['segunda', 'segunda feira'], day: 1 },
    { names: ['terca', 'terca feira'], day: 2 },
    { names: ['quarta', 'quarta feira'], day: 3 },
    { names: ['quinta', 'quinta feira'], day: 4 },
    { names: ['sexta', 'sexta feira'], day: 5 },
    { names: ['sabado'], day: 6 },
  ];
  const weekday = weekdays.find(({ names }) => names.some((name) => (
    new RegExp(`\\b${name.replace(' ', '\\s+')}\\b`).test(normalizedPrompt)
  )));
  if (!weekday || !/^\d{4}-\d{2}-\d{2}$/.test(currentDate)) return null;

  const [year, month, day] = currentDate.split('-').map(Number);
  const baseDate = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(baseDate.getTime())) return null;
  const offset = (weekday.day - baseDate.getUTCDay() + 7) % 7 || 7;
  baseDate.setUTCDate(baseDate.getUTCDate() + offset);
  return baseDate.toISOString().slice(0, 10);
};

const normalizeDate = (value: unknown): string | null => {
  const normalized = cleanText(value, 10);
  if (!normalized || !/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const [year, month, day] = normalized.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return normalized;
};

const normalizeTime = (value: unknown): string | null => {
  const normalized = cleanText(value, 5);
  if (!normalized || !/^\d{2}:\d{2}$/.test(normalized)) return null;
  const [hours, minutes] = normalized.split(':').map(Number);
  return hours <= 23 && minutes <= 59 ? normalized : null;
};

const normalizePeriod = (value: unknown): AssistantPeriod | null => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'manhã' || normalized === 'manha') return 'Manhã';
  if (normalized === 'tarde') return 'Tarde';
  if (normalized === 'noite') return 'Noite';
  return null;
};

const normalizeModality = (value: unknown): AssistantModality | null => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized.includes('tele')) return 'Teleconsulta';
  if (normalized.includes('presen')) return 'Presencial';
  return null;
};

const normalizeProfessionalPreference = (value: unknown): AssistantProfessionalPreference | null => {
  const normalized = normalizeComparableText(value);
  return normalized === 'first available' || normalized === 'primeiro disponivel'
    ? 'first_available'
    : null;
};

const normalizePositiveInteger = (value: unknown, min: number, max: number): number | null => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
};

const parseJsonObject = (content: string): Record<string, unknown> => {
  const normalized = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const objectStart = normalized.indexOf('{');
  const objectEnd = normalized.lastIndexOf('}');
  if (objectStart < 0 || objectEnd <= objectStart) throw new Error('A resposta da IA não contém um objeto válido.');
  const parsed = JSON.parse(normalized.slice(objectStart, objectEnd + 1));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('A resposta da IA não contém um objeto válido.');
  return parsed as Record<string, unknown>;
};

const normalizeDraft = (
  raw: Record<string, unknown>,
  prompt: string,
  currentDate: string,
): AppointmentAssistantDraft => {
  const rawProcedureNames = Array.isArray(raw.procedureNames)
    ? raw.procedureNames
    : [raw.procedureName];
  const procedureNames = Array.from(new Set(
    rawProcedureNames
      .map((value) => cleanText(value, 120))
      .filter((value): value is string => Boolean(value)),
  )).slice(0, 8);

  return {
    patientName: cleanText(raw.patientName),
    patientCpf: cleanText(raw.patientCpf, 20),
    procedureNames,
    professionalName: cleanText(raw.professionalName),
    professionalPreference: normalizeProfessionalPreference(raw.professionalPreference),
    date: resolveWeekdayFromPrompt(prompt, currentDate) || normalizeDate(raw.date),
    time: normalizeTime(raw.time),
    period: normalizePeriod(raw.period),
    modality: normalizeModality(raw.modality),
    insuranceName: cleanText(raw.insuranceName),
    recurrenceOccurrences: normalizePositiveInteger(raw.recurrenceOccurrences, 2, 12),
    recurrenceIntervalWeeks: normalizePositiveInteger(raw.recurrenceIntervalWeeks, 1, 4),
    simultaneous: typeof raw.simultaneous === 'boolean' ? raw.simultaneous : null,
    observations: cleanText(raw.observations, 500),
  };
};

async function callGroq(prompt: string, currentDate: string): Promise<AppointmentAssistantDraft> {
  if (!GROQ_API_KEY) throw new Error('Serviço de IA não configurado.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const systemPrompt = `Você é um parser de pedidos de agendamento para uma clínica no Brasil.
Sua única tarefa é transformar a mensagem do usuário em dados estruturados para um rascunho de agendamento.
Não tome decisões clínicas, não confirme disponibilidade e não invente dados.
Data atual do sistema: ${currentDate}. Fuso horário: ${CLINIC_TIME_ZONE}.

Regras:
- Retorne SOMENTE um objeto JSON válido, sem markdown e sem explicações.
- Datas devem estar em YYYY-MM-DD. Resolva expressões como "amanhã" usando a data atual.
- Horários devem estar em HH:mm. Se houver apenas período, preencha period e deixe time nulo.
- Preserve nomes como foram escritos, sem tentar corrigir ou completar nomes cadastrados.
- procedureNames deve ser um array; use [] quando o procedimento não estiver claro.
- Quando o usuário disser "primeiro médico disponível", "primeiro profissional disponível" ou "qualquer profissional", deixe professionalName como null e use professionalPreference = "first_available".
- modality só pode ser "Presencial" ou "Teleconsulta".
- period só pode ser "Manhã", "Tarde" ou "Noite".
- recurrenceOccurrences deve ser um inteiro entre 2 e 12 quando houver recorrência; caso contrário, null.
- recurrenceIntervalWeeks deve ser um inteiro entre 1 e 4 quando houver recorrência; caso contrário, null.
- simultaneous deve ser true somente quando o usuário pedir atendimento simultâneo/conjunto; caso contrário, false ou null.
- Não inclua CPF se ele não aparecer na mensagem.

Formato exato:
{
  "patientName": string|null,
  "patientCpf": string|null,
  "procedureNames": string[],
  "professionalName": string|null,
  "professionalPreference": "first_available"|null,
  "date": string|null,
  "time": string|null,
  "period": "Manhã"|"Tarde"|"Noite"|null,
  "modality": "Presencial"|"Teleconsulta"|null,
  "insuranceName": string|null,
  "recurrenceOccurrences": number|null,
  "recurrenceIntervalWeeks": number|null,
  "simultaneous": boolean|null,
  "observations": string|null
}`;

    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0,
        max_tokens: 700,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error('Não foi possível interpretar o pedido agora.');
    }

    const data = await response.json() as any;
    const content = String(data?.choices?.[0]?.message?.content || '');
    return normalizeDraft(parseJsonObject(content), prompt, currentDate);
  } finally {
    clearTimeout(timeout);
  }
}

export default async function appointmentAssistantRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  app.post('/parse', {
    schema: {
      body: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt: { type: 'string', minLength: 3, maxLength: 800 },
          currentDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { prompt?: string; currentDate?: string };
    const prompt = String(body?.prompt || '').replace(/\s+/g, ' ').trim();
    if (prompt.length < 3) return reply.code(400).send({ error: 'Descreva o agendamento que deseja preparar.' });
    if (prompt.length > 800) return reply.code(400).send({ error: 'Descreva o pedido em até 800 caracteres.' });

    const currentDate = normalizeDate(body.currentDate) || new Intl.DateTimeFormat('en-CA', {
      timeZone: CLINIC_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

    try {
      const draft = await callGroq(prompt, currentDate);
      return reply.send({ draft, generatedAt: new Date().toISOString() });
    } catch (error: any) {
      const message = error?.name === 'AbortError'
        ? 'A interpretação demorou mais que o esperado. Tente novamente.'
        : String(error?.message || 'Não foi possível interpretar o pedido.');
      const statusCode = message === 'Serviço de IA não configurado.' ? 503 : 502;
      return reply.code(statusCode).send({ error: message });
    }
  });
}
