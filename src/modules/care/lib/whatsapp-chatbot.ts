import { randomBytes } from 'crypto';
import prisma from '../lib/prisma';
import { MetaMessagingService } from './messaging';
import { publishAppointmentCreatedEvent } from './appointment-whatsapp-events';
import { isValidCpf, normalizeCpf } from '../../../lib/cpf';

const CLINIC_TIME_ZONE = process.env.APP_TIMEZONE || 'America/Sao_Paulo';
const CHATBOT_BRANCH_ID = String(process.env.WHATSAPP_CHATBOT_BRANCH_ID || '').trim();
const DEFAULT_SEARCH_DAYS = Math.max(1, Number(process.env.WHATSAPP_CHATBOT_SEARCH_DAYS || 30));
const CONVERSATION_TIMEOUT_MS = 2 * 60 * 1000;
const OPEN_APPOINTMENT_STATUSES = new Set([
  'AGENDADO',
  'CONFIRMADO',
  'PENDENTE',
  'PENDING',
  'RESERVA_WHATSAPP_PENDENTE',
  'EM ANDAMENTO',
  'EM_ANDAMENTO',
  'IN_PROGRESS',
]);

type ConversationContext = {
  serviceType?: 'CONSULTA' | 'EXAME';
  selectedBranchId?: string | null;
  selectedBranchName?: string | null;
  selectedInsurance?: string | null;
  selectedProcedureId?: string | null;
  selectedProcedureName?: string | null;
  selectedProcedurePrice?: number | null;
  selectedDoctorId?: string | null;
  selectedDoctorName?: string | null;
  suggestedDate?: string | null;
  suggestedTime?: string | null;
  suggestedDurationMinutes?: number | null;
  preferredDate?: string | null;
  cpfCandidate?: string | null;
  nameCandidate?: string | null;
  birthDateCandidate?: string | null;
  privateProcedureSearchText?: string | null;
  privateProcedureSearchAttempts?: number | null;
  privateProcedureMatchId?: string | null;
  privateProcedureMatchName?: string | null;
  privateProcedureMatchPrice?: number | null;
  options?: Array<{ value: string; label: string }>;
  lastPrompt?: string | null;
  history?: ConversationHistoryEntry[];
};

type EditableStepKey =
  | 'UNIT'
  | 'SERVICE'
  | 'INSURANCE'
  | 'PROCEDURE'
  | 'SLOT'
  | 'CPF'
  | 'NAME'
  | 'BIRTHDATE';

type ChatbotInput = {
  phone: string;
  text: string;
  metadata?: Record<string, unknown>;
  branchIdHint?: string;
};

type ListOption = { title: string; postbackText: string; description?: string };

type ChatbotResponse = {
  text: string;
  binaryOptions?: boolean;
  listOptions?: { buttonTitle?: string; sectionTitle?: string; options: ListOption[] };
};

type ChatbotResult = {
  handled: boolean;
  response?: ChatbotResponse;
};

type BranchConfig = {
  branchId: string;
  branchName: string | null;
  apiKey: string;
  appName: string;
  appId: string | null;
  sourceNumber: string;
  flowId: string | null;
};

type PatientLookup = {
  id: string;
  name: string | null;
  cpf: string | null;
  healthInsuranceName: string | null;
};

type SlotSuggestion = {
  doctorId: string;
  doctorName: string;
  date: string;
  time: string;
  durationMinutes: number;
};

type ConversationHistoryEntry = {
  state: string;
  prompt: string; // kept for backward-compat with persisted JSON; use savedResponse when present
  savedResponse?: ChatbotResponse;
  context: Omit<ConversationContext, 'history'>;
};

export type HumanFlowDefinition = {
  key: string;
  label: string;
};

export const HUMAN_FLOWS: HumanFlowDefinition[] = [
  { key: 'DUVIDAS', label: 'Dúvidas' },
  { key: 'CONFIRMACAO_REAGENDAMENTO', label: 'Reagendamento de confirmação' },
  { key: 'CONVENIO_NAO_ENCONTRADO', label: 'Convênio não encontrado' },
  { key: 'PROCEDIMENTO_NAO_ENCONTRADO', label: 'Procedimento não encontrado' },
  { key: 'PROCEDIMENTO_INVALIDO', label: 'Procedimento inválido' },
  { key: 'SEM_HORARIO_AUTOMATICO', label: 'Sem horário automático' },
  { key: 'PREFERENCIA_SEM_DISPONIBILIDADE', label: 'Preferência sem disponibilidade' },
];

const normalizeDigits = (value: unknown) => String(value || '').replace(/\D/g, '');

const normalizeText = (value: unknown) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

const formatPhoneForLookup = (phone: string) => {
  const digits = normalizeDigits(phone);
  return digits.length > 11 ? digits.slice(-11) : digits;
};

const formatCpf = (cpf: string) => {
  const digits = normalizeDigits(cpf).slice(0, 11);
  if (digits.length !== 11) return digits;
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
};

const formatCurrency = (value: number | string | null | undefined) => {
  const numeric = Number(value || 0);
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(Number.isFinite(numeric) ? numeric : 0);
};

const parseJsonContext = (value: unknown): ConversationContext => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as ConversationContext;
};

const serializeOptions = (options: Array<{ value: string; label: string }>) => options
  .map((option, index) => `${index + 1}. ${option.label}`)
  .join('\n');

// Converts a named options array into listOptions for interactive list messages.
// postbackText uses the 1-based index so existing resolveOptionSelection() keeps working.
const toListOptions = (
  options: Array<{ value: string; label: string }>,
  buttonTitle?: string,
  sectionTitle?: string,
): ChatbotResponse['listOptions'] => ({
  buttonTitle: buttonTitle || 'Ver opções',
  sectionTitle,
  options: options.map((opt, i) => ({ title: opt.label, postbackText: String(i + 1) })),
});

const MENU_LIST_OPTIONS: ChatbotResponse['listOptions'] = {
  buttonTitle: 'Ver opções',
  sectionTitle: 'O que você precisa?',
  options: [
    { title: 'Marcação de consulta', postbackText: '1' },
    { title: 'Marcação de exame', postbackText: '2' },
    { title: 'Dúvidas', postbackText: '3' },
    { title: 'Próximas consultas/exames', postbackText: '4' },
  ],
};

const buildMenuMessage = (patientName?: string | null): ChatbotResponse => {
  const greeting = patientName
    ? `Olá, ${patientName}. Como posso te ajudar hoje?`
    : 'Olá. Como posso te ajudar hoje?';

  return {
    text: greeting,
    listOptions: MENU_LIST_OPTIONS,
  };
};

const buildYesNoMessage = (body: string): ChatbotResponse => ({
  text: body,
  binaryOptions: true,
});

const buildHumanHandoffMessage = (protocolNumber?: string | null) => ({
  text: [
    'Perfeito. Vou encaminhar você para um dos nossos atendentes.',
    protocolNumber ? `Seu protocolo de atendimento é: ${protocolNumber}` : null,
  ].filter(Boolean).join('\n\n'),
});

const parseYesNo = (text: string): boolean | null => {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  if (normalized === '1' || normalized === 'sim' || normalized === 's') return true;
  if (normalized === '2' || normalized === 'nao' || normalized === 'não' || normalized === 'n') return false;
  return null;
};

const parseServiceType = (text: string): 'CONSULTA' | 'EXAME' | 'DUVIDAS' | 'NEXT_APPOINTMENTS' | null => {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  if (normalized === '1' || normalized.includes('consulta')) return 'CONSULTA';
  if (normalized === '2' || normalized.includes('exame')) return 'EXAME';
  if (normalized === '3' || normalized.includes('duvida') || normalized.includes('dúvida')) return 'DUVIDAS';
  if (
    normalized === '4'
    || normalized.includes('proximas consultas')
    || normalized.includes('próximas consultas')
    || normalized.includes('proximos exames')
    || normalized.includes('próximos exames')
    || normalized.includes('proximas consulta')
    || normalized.includes('próximas consulta')
    || normalized.includes('proximos exame')
    || normalized.includes('próximos exame')
  ) return 'NEXT_APPOINTMENTS';
  return null;
};

const parseEditableStepSelection = (text: string): EditableStepKey | null => {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  if (normalized === '0' || normalized.includes('unidade') || normalized.includes('filial')) return 'UNIT';
  if (normalized === '1' || normalized.includes('tipo') || normalized.includes('consulta') || normalized.includes('exame')) return 'SERVICE';
  if (normalized === '2' || normalized.includes('convenio') || normalized.includes('convênio')) return 'INSURANCE';
  if (normalized === '3' || normalized.includes('procedimento')) return 'PROCEDURE';
  if (normalized === '4' || normalized.includes('horario') || normalized.includes('horário') || normalized.includes('data')) return 'SLOT';
  if (normalized === '5' || normalized === 'cpf') return 'CPF';
  if (normalized === '6' || normalized.includes('nome')) return 'NAME';
  if (
    normalized === '7'
    || normalized.includes('nascimento')
    || normalized.includes('data de nascimento')
    || normalized.includes('birth')
  ) return 'BIRTHDATE';

  return null;
};

const parseProcedureNotFoundAction = (text: string): 'HANDOFF' | 'PRIVATE' | null => {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  if (normalized === '1' || normalized.includes('atendente')) return 'HANDOFF';
  if (normalized === '2' || normalized.includes('particular')) return 'PRIVATE';
  return null;
};

const shouldResetConversation = (text: string) => {
  const normalized = normalizeText(text);
  return normalized === 'sair'
    || normalized === 'menu'
    || normalized === 'inicio'
    || normalized === 'início'
    || normalized === 'oi'
    || normalized === 'ola'
    || normalized === 'olá'
    || normalized === 'bom dia'
    || normalized === 'boa tarde'
    || normalized === 'boa noite';
};

const shouldGoBackConversation = (text: string) => normalizeText(text) === 'voltar';

const isConversationExpired = (lastInteractionAt?: string | Date | null) => {
  if (!lastInteractionAt) return false;
  const timestamp = new Date(lastInteractionAt).getTime();
  if (Number.isNaN(timestamp)) return false;
  return (Date.now() - timestamp) > CONVERSATION_TIMEOUT_MS;
};

const BINARY_RESPONSE_STATES = new Set([
  'AWAITING_PROCEDURE_NOT_FOUND_ACTION',
  'AWAITING_PRIVATE_PROCEDURE_CONFIRMATION',
  'AWAITING_PRIVATE_PROCEDURE_MATCH_CONFIRMATION',
  'AWAITING_SLOT_CONFIRMATION',
  'AWAITING_CPF_CONFIRMATION',
  'AWAITING_FINAL_CONFIRMATION',
]);

const buildEditSelectionPrompt = (params: {
  patient: PatientLookup | null;
  conversation: any;
  context: ConversationContext;
}) => {
  const isNewPatient = !params.patient?.id && !params.conversation.patientId;
  const options = [
    '0. Unidade',
    '1. Tipo de atendimento',
    '2. Convênio',
    '3. Procedimento',
    '4. Data ou horário',
    '5. CPF',
  ];

  if (isNewPatient) {
    options.push('6. Nome completo');
    options.push('7. Data de nascimento');
  }

  return `Sem problema. Qual etapa você deseja alterar?\n${options.join('\n')}\n\nVocê pode responder com o número da opção ou com o nome da etapa.`;
};

const hasCollectedNewPatientData = (conversation: any, context: ConversationContext, patient: PatientLookup | null) => {
  const hasExistingPatient = Boolean(patient?.id || conversation.patientId);
  if (hasExistingPatient) return true;

  return Boolean(
    (context.cpfCandidate || patient?.cpf)
    && (context.nameCandidate || conversation.patientName || patient?.name)
    && context.birthDateCandidate,
  );
};

const stripHistoryFromContext = (context: ConversationContext): Omit<ConversationContext, 'history'> => {
  const { history: _history, ...rest } = context;
  return rest;
};

const pushHistoryEntry = (
  context: ConversationContext,
  state: string,
  promptOrResponse: string | ChatbotResponse,
): ConversationContext => {
  const savedResponse: ChatbotResponse = typeof promptOrResponse === 'string'
    ? { text: promptOrResponse }
    : promptOrResponse;
  return {
    ...context,
    history: [
      ...((context.history || []).slice(-9)),
      {
        state,
        prompt: savedResponse.text,
        savedResponse,
        context: stripHistoryFromContext(context),
      },
    ],
  };
};

const restorePreviousStep = (context: ConversationContext): {
  state: string;
  context: ConversationContext;
  response: ChatbotResponse;
} | null => {
  const history = context.history || [];
  const previous = history[history.length - 1];
  if (!previous) return null;

  return {
    state: previous.state,
    context: {
      ...previous.context,
      lastPrompt: previous.prompt,
      history: history.slice(0, -1),
    },
    response: previous.savedResponse || {
      text: previous.prompt,
      binaryOptions: BINARY_RESPONSE_STATES.has(previous.state),
    },
  };
};

const pad = (value: number) => String(value).padStart(2, '0');

const formatDateIso = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const formatDateLabel = (dateIso: string) => {
  const [year, month, day] = String(dateIso).split('-').map((part) => Number(part));
  if (!year || !month || !day) return dateIso;
  return `${pad(day)}/${pad(month)}/${year}`;
};

const timeToMinutes = (value: string) => {
  const [hour, minute] = String(value).split(':').map((part) => Number(part));
  return ((Number.isFinite(hour) ? hour : 0) * 60) + (Number.isFinite(minute) ? minute : 0);
};

const minutesToTime = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

const resolveDurationMinutes = (value: unknown) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 30;
  return Math.max(15, Math.floor(numeric));
};

const timeRangesOverlap = (
  startA: string,
  durationA: number,
  startB: string,
  durationB: number,
) => {
  const startAMinutes = timeToMinutes(startA);
  const endAMinutes = startAMinutes + resolveDurationMinutes(durationA);
  const startBMinutes = timeToMinutes(startB);
  const endBMinutes = startBMinutes + resolveDurationMinutes(durationB);
  return startAMinutes < endBMinutes && startBMinutes < endAMinutes;
};

const normalizeWeekdayToken = (value?: string | null): string | null => {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (normalized === 'segunda' || normalized === 'monday') return 'SEGUNDA';
  if (normalized === 'terca' || normalized === 'terça' || normalized === 'tuesday') return 'TERCA';
  if (normalized === 'quarta' || normalized === 'wednesday') return 'QUARTA';
  if (normalized === 'quinta' || normalized === 'thursday') return 'QUINTA';
  if (normalized === 'sexta' || normalized === 'friday') return 'SEXTA';
  if (normalized === 'sabado' || normalized === 'sábado' || normalized === 'saturday') return 'SABADO';
  if (normalized === 'domingo' || normalized === 'sunday') return 'DOMINGO';
  return null;
};

const JS_DAY_TO_WEEKDAY = ['DOMINGO', 'SEGUNDA', 'TERCA', 'QUARTA', 'QUINTA', 'SEXTA', 'SABADO'];

const parseDoctorWindows = (doctor: any): Array<{ weekdays: string[]; hoursStart?: string | null; hoursEnd?: string | null }> => {
  const rawSchedules = (() => {
    if (Array.isArray(doctor?.workingSchedules)) return doctor.workingSchedules;
    if (typeof doctor?.workingSchedules === 'string' && doctor.workingSchedules.trim()) {
      try {
        const parsed = JSON.parse(doctor.workingSchedules);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  })();

  const fromSchedules = rawSchedules
    .map((schedule: any) => {
      const weekdays = Array.isArray(schedule?.days)
        ? schedule.days.map((item: any) => normalizeWeekdayToken(item)).filter(Boolean)
        : [];

      if (!weekdays.length) return null;
      return {
        weekdays,
        hoursStart: schedule?.hoursStart || null,
        hoursEnd: schedule?.hoursEnd || null,
      };
    })
    .filter(Boolean) as Array<{ weekdays: string[]; hoursStart?: string | null; hoursEnd?: string | null }>;

  if (fromSchedules.length) return fromSchedules;

  const fallbackWeekdays = Array.isArray(doctor?.workingDays) && doctor.workingDays.length
    ? doctor.workingDays.map((item: any) => normalizeWeekdayToken(item)).filter(Boolean)
    : [...JS_DAY_TO_WEEKDAY];

  return [{
    weekdays: fallbackWeekdays as string[],
    hoursStart: doctor?.workingHoursStart || '08:00',
    hoursEnd: doctor?.workingHoursEnd || '18:00',
  }];
};

const buildWindowSlots = (hoursStart?: string | null, hoursEnd?: string | null, stepMinutes = 15) => {
  const startMinutes = timeToMinutes(hoursStart || '08:00');
  const endMinutes = timeToMinutes(hoursEnd || '18:00');
  const slots: string[] = [];
  for (let current = startMinutes; current <= endMinutes; current += stepMinutes) {
    slots.push(minutesToTime(current));
  }
  return slots;
};

const parsePreferredDate = (text: string): string | null => {
  const normalized = normalizeText(text);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (normalized === 'hoje') return formatDateIso(today);
  if (normalized === 'amanha' || normalized === 'amanhã') {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return formatDateIso(tomorrow);
  }

  const isoMatch = String(text).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  const brMatch = String(text).trim().match(/^(\d{2})\/(\d{2})(?:\/(\d{4}))?$/);
  if (brMatch) {
    const year = brMatch[3] ? Number(brMatch[3]) : today.getFullYear();
    const parsed = new Date(year, Number(brMatch[2]) - 1, Number(brMatch[1]));
    if (!Number.isNaN(parsed.getTime())) {
      if (!brMatch[3] && parsed < today) parsed.setFullYear(parsed.getFullYear() + 1);
      return formatDateIso(parsed);
    }
  }

  const weekday = normalizeWeekdayToken(text);
  if (weekday) {
    const current = new Date(today);
    for (let offset = 0; offset < 14; offset += 1) {
      if (JS_DAY_TO_WEEKDAY[current.getDay()] === weekday) return formatDateIso(current);
      current.setDate(current.getDate() + 1);
    }
  }

  return null;
};

const parseBirthDate = (text: string): string | null => {
  const trimmed = String(text || '').trim();
  const brMatch = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!brMatch) return null;
  const year = Number(brMatch[3]);
  const month = Number(brMatch[2]);
  const day = Number(brMatch[1]);
  const parsed = new Date(year, month - 1, day);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null;
  if (parsed > new Date()) return null;
  return formatDateIso(parsed);
};

const formatBirthDateLabel = (dateIso?: string | null) => dateIso ? formatDateLabel(dateIso) : 'Não informada';

const buildComparableSlot = (date?: string | null, time?: string | null) => {
  const safeDate = String(date || '9999-12-31');
  const safeTime = String(time || '23:59').slice(0, 5);
  return `${safeDate} ${safeTime}`;
};

const getCurrentClinicSlot = () => {
  const now = new Date();
  return buildComparableSlot(
    now.toLocaleDateString('en-CA', { timeZone: CLINIC_TIME_ZONE }),
    now.toLocaleTimeString('pt-BR', {
      timeZone: CLINIC_TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }),
  );
};

const resolveOptionSelection = (
  text: string,
  options: Array<{ value: string; label: string }>,
): { value: string; label: string } | null => {
  const trimmed = String(text || '').trim();
  if (!trimmed || !options.length) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= options.length) {
    return options[numeric - 1];
  }

  const normalized = normalizeText(trimmed);
  return options.find((option) => {
    const optionLabel = normalizeText(option.label);
    return optionLabel === normalized || optionLabel.includes(normalized) || normalized.includes(optionLabel);
  }) || null;
};

function configToBranchConfig(branchId: string, branchName: string | null, config: {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  flowId: string | null;
  appId?: string | null;
}): BranchConfig {
  return {
    branchId,
    branchName,
    apiKey: config.accountSid,
    appName: config.authToken,
    appId: config.appId || null,
    sourceNumber: config.fromNumber,
    flowId: config.flowId,
  };
}

async function resolveBranchConfig(branchIdHint?: string): Promise<BranchConfig | null> {
  const preferredBranchId = String(branchIdHint || '').trim();
  if (preferredBranchId) {
    const branch = await prisma.branch.findUnique({ where: { id: preferredBranchId } });
    const config = await prisma.whatsAppConfig.findUnique({ where: { branchId: preferredBranchId } });
    if (config?.isActive) {
      return configToBranchConfig(preferredBranchId, branch?.tradeName || null, config);
    }
  }

  if (CHATBOT_BRANCH_ID) {
    const branch = await prisma.branch.findUnique({ where: { id: CHATBOT_BRANCH_ID } });
    const config = await prisma.whatsAppConfig.findUnique({ where: { branchId: CHATBOT_BRANCH_ID } });
    if (config?.isActive) {
      return configToBranchConfig(CHATBOT_BRANCH_ID, branch?.tradeName || null, config);
    }
  }

  const activeConfigs = await prisma.whatsAppConfig.findMany({
    where: { isActive: true },
    take: 2,
    orderBy: { createdAt: 'asc' },
  });

  if (activeConfigs.length === 1) {
    const branch = await prisma.branch.findUnique({ where: { id: activeConfigs[0].branchId } });
    return configToBranchConfig(activeConfigs[0].branchId, branch?.tradeName || null, activeConfigs[0]);
  }

  return null;
}


async function sendResponse(branchConfig: BranchConfig, phone: string, response: ChatbotResponse) {
  const messaging = new MetaMessagingService({
    bearerToken: branchConfig.apiKey,
    appId: branchConfig.appId || branchConfig.appName,
    sourceNumber: branchConfig.sourceNumber,
  });

  if (response.binaryOptions) {
    return messaging.sendQuickReplyMessage({
      to: phone,
      body: response.text,
      options: [
        { title: 'Sim', postbackText: 'SIM' },
        { title: 'Não', postbackText: 'NAO' },
      ],
    });
  }

  if (response.listOptions) {
    return messaging.sendListMessage({
      to: phone,
      body: response.text,
      buttonTitle: response.listOptions.buttonTitle,
      sectionTitle: response.listOptions.sectionTitle,
      options: response.listOptions.options,
    });
  }

  return messaging.sendTextMessage({ to: phone, message: response.text });
}

async function lookupPatient(branchId: string, phone: string): Promise<PatientLookup | null> {
  const lookup = formatPhoneForLookup(phone);
  if (!lookup) return null;

  const candidates = await prisma.patient.findMany({
    where: {
      branchId,
      isActive: true,
      OR: [
        { cellphone: { contains: lookup } },
        { phone: { contains: lookup } },
      ],
    },
    select: {
      id: true,
      name: true,
      cpf: true,
      healthInsuranceName: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: 'desc' },
    take: 5,
  });

  return candidates[0]
    ? {
        id: String(candidates[0].id),
        name: candidates[0].name || null,
        cpf: candidates[0].cpf || null,
        healthInsuranceName: candidates[0].healthInsuranceName || null,
      }
    : null;
}

async function findNextAppointmentForPatient(params: {
  referenceBranchId: string;
  patient: PatientLookup | null;
}) {
  if (!params.patient?.id && !params.patient?.cpf) return null;

  const referenceBranch = await prisma.branch.findUnique({
    where: { id: params.referenceBranchId },
    select: { companyId: true },
  });

  const companyBranchIds = referenceBranch?.companyId
    ? (await prisma.branch.findMany({
      where: { companyId: referenceBranch.companyId },
      select: { id: true, tradeName: true },
      orderBy: { tradeName: 'asc' },
    }))
    : [];

  const branchIds = companyBranchIds.length
    ? companyBranchIds.map((item: any) => String(item.id))
    : [params.referenceBranchId];

  const branchNameById = new Map(
    companyBranchIds.map((item: any) => [String(item.id), String(item.tradeName || 'Unidade sem nome')]),
  );

  if (!branchNameById.size) {
    const fallbackBranch = await prisma.branch.findUnique({
      where: { id: params.referenceBranchId },
      select: { id: true, tradeName: true },
    });
    if (fallbackBranch) {
      branchNameById.set(
        String(fallbackBranch.id),
        String(fallbackBranch.tradeName || 'Unidade sem nome'),
      );
    }
  }

  const appointments = await prisma.appointment.findMany({
    where: {
      branchId: { in: branchIds },
      isActive: true,
      status: { in: Array.from(OPEN_APPOINTMENT_STATUSES) },
      OR: [
        ...(params.patient.id ? [{ patientId: params.patient.id }] : []),
        ...(params.patient.cpf ? [{ patientCpf: params.patient.cpf }] : []),
      ],
    },
    select: {
      id: true,
      branchId: true,
      date: true,
      time: true,
      type: true,
      status: true,
      doctorName: true,
      specialty: true,
      convenio: true,
    },
  });

  const nowComparable = getCurrentClinicSlot();
  const nextAppointment = appointments
    .filter((item: any) => item?.date && item?.time)
    .sort((a: any, b: any) => (
      buildComparableSlot(a.date, a.time).localeCompare(buildComparableSlot(b.date, b.time))
    ))
    .find((item: any) => buildComparableSlot(item.date, item.time) >= nowComparable);

  if (!nextAppointment) return null;

  return {
    id: String(nextAppointment.id),
    branchId: nextAppointment.branchId ? String(nextAppointment.branchId) : null,
    branchName: nextAppointment.branchId
      ? String(branchNameById.get(String(nextAppointment.branchId)) || 'Unidade sem nome')
      : 'Unidade não informada',
    date: String(nextAppointment.date),
    time: String(nextAppointment.time).slice(0, 5),
    type: String(nextAppointment.type || '').trim() || null,
    status: String(nextAppointment.status || '').trim() || null,
    doctorName: nextAppointment.doctorName ? String(nextAppointment.doctorName) : null,
    specialty: nextAppointment.specialty ? String(nextAppointment.specialty) : null,
    convenio: nextAppointment.convenio ? String(nextAppointment.convenio) : null,
  };
}

const formatAppointmentTypeLabel = (value?: string | null) => {
  const normalized = normalizeText(value);
  if (!normalized) return 'Atendimento';
  if (normalized.includes('exame')) return 'Exame';
  if (normalized.includes('consulta')) return 'Consulta';
  if (normalized.includes('whatsapp')) return 'Atendimento';
  return String(value).trim() || 'Atendimento';
};

const buildNextAppointmentMessage = (params: {
  patientName?: string | null;
  appointment: {
    branchName?: string | null;
    date: string;
    time: string;
    type?: string | null;
    doctorName?: string | null;
    specialty?: string | null;
    convenio?: string | null;
  };
}) => {
  const header = params.patientName
    ? `Encontrei seu próximo agendamento, ${params.patientName}:`
    : 'Encontrei seu próximo agendamento:';

  return [
    header,
    `Unidade: ${params.appointment.branchName || 'Não informada'}`,
    `Profissional: ${params.appointment.doctorName || 'Não informado'}`,
    `Procedimento: ${params.appointment.specialty || 'Não informado'}`,
    `Dia: ${formatDateLabel(params.appointment.date)}`,
    `Horário: ${params.appointment.time || 'Não informado'}`,
  ].join('\n');
};

async function listUnitOptions(referenceBranchId: string) {
  const referenceBranch = await prisma.branch.findUnique({
    where: { id: referenceBranchId },
    select: { id: true, companyId: true },
  });

  if (!referenceBranch?.companyId) {
    const fallbackBranch = await prisma.branch.findUnique({
      where: { id: referenceBranchId },
      select: { id: true, tradeName: true },
    });

    return fallbackBranch
      ? [{ value: fallbackBranch.id, label: fallbackBranch.tradeName || 'Unidade principal' }]
      : [];
  }

  const branches = await prisma.branch.findMany({
    where: { companyId: referenceBranch.companyId },
    select: {
      id: true,
      tradeName: true,
    },
    orderBy: { tradeName: 'asc' },
  });

  return branches.map((branch: any) => ({
    value: String(branch.id),
    label: String(branch.tradeName || 'Unidade sem nome'),
  }));
}

async function upsertConversation(params: {
  branchId: string;
  phone: string;
  patient?: PatientLookup | null;
}) {
  const { branchId, phone, patient } = params;
  const normalizedPhone = formatPhoneForLookup(phone);

  const existing = await prisma.whatsAppConversation.findUnique({
    where: {
      branchId_phone: {
        branchId,
        phone: normalizedPhone,
      },
    },
  });

  if (existing) {
    if (patient && (!existing.patientId || existing.patientId !== patient.id)) {
      return prisma.whatsAppConversation.update({
        where: { id: existing.id },
        data: {
          patientId: patient.id,
          patientName: patient.name || existing.patientName || null,
        },
      });
    }
    return existing;
  }

  return prisma.whatsAppConversation.create({
    data: {
      branchId,
      phone: normalizedPhone,
      patientId: patient?.id || null,
      patientName: patient?.name || null,
      state: 'MENU',
      context: {},
    },
  });
}

async function saveConversation(conversationId: string, data: {
  state?: string;
  selectedService?: string | null;
  context?: ConversationContext;
  lastInboundMessage?: string | null;
  lastOutboundMessage?: string | null;
  patientId?: string | null;
  patientName?: string | null;
  handoffTicketId?: string | null;
  reservedAppointmentId?: string | null;
  humanStatus?: 'QUEUED' | 'ASSIGNED' | 'CLOSED' | null;
  humanFlowKey?: string | null;
  humanFlowLabel?: string | null;
  humanAssignedUserId?: string | null;
  humanAssignedUserName?: string | null;
  humanAssignedAt?: Date | null;
  humanClosedAt?: Date | null;
  humanClosedByUserId?: string | null;
  humanClosedByUserName?: string | null;
  humanProtocolNumber?: string | null;
  humanProtocolStartedAt?: Date | null;
  humanProtocolClosedAt?: Date | null;
  humanIdleWarningSentAt?: Date | null;
  humanLastOperatorMessageAt?: Date | null;
  humanLastPatientMessageAt?: Date | null;
}) {
  return prisma.whatsAppConversation.update({
    where: { id: conversationId },
    data: {
      ...(data.state ? { state: data.state } : {}),
      ...(data.selectedService !== undefined ? { selectedService: data.selectedService } : {}),
      ...(data.context !== undefined ? { context: data.context } : {}),
      ...(data.lastInboundMessage !== undefined ? { lastInboundMessage: data.lastInboundMessage } : {}),
      ...(data.lastOutboundMessage !== undefined ? { lastOutboundMessage: data.lastOutboundMessage } : {}),
      ...(data.patientId !== undefined ? { patientId: data.patientId } : {}),
      ...(data.patientName !== undefined ? { patientName: data.patientName } : {}),
      ...(data.handoffTicketId !== undefined ? { handoffTicketId: data.handoffTicketId } : {}),
      ...(data.reservedAppointmentId !== undefined ? { reservedAppointmentId: data.reservedAppointmentId } : {}),
      ...(data.humanStatus !== undefined ? { humanStatus: data.humanStatus } : {}),
      ...(data.humanFlowKey !== undefined ? { humanFlowKey: data.humanFlowKey } : {}),
      ...(data.humanFlowLabel !== undefined ? { humanFlowLabel: data.humanFlowLabel } : {}),
      ...(data.humanAssignedUserId !== undefined ? { humanAssignedUserId: data.humanAssignedUserId } : {}),
      ...(data.humanAssignedUserName !== undefined ? { humanAssignedUserName: data.humanAssignedUserName } : {}),
      ...(data.humanAssignedAt !== undefined ? { humanAssignedAt: data.humanAssignedAt } : {}),
      ...(data.humanClosedAt !== undefined ? { humanClosedAt: data.humanClosedAt } : {}),
      ...(data.humanClosedByUserId !== undefined ? { humanClosedByUserId: data.humanClosedByUserId } : {}),
      ...(data.humanClosedByUserName !== undefined ? { humanClosedByUserName: data.humanClosedByUserName } : {}),
      ...(data.humanProtocolNumber !== undefined ? { humanProtocolNumber: data.humanProtocolNumber } : {}),
      ...(data.humanProtocolStartedAt !== undefined ? { humanProtocolStartedAt: data.humanProtocolStartedAt } : {}),
      ...(data.humanProtocolClosedAt !== undefined ? { humanProtocolClosedAt: data.humanProtocolClosedAt } : {}),
      ...(data.humanIdleWarningSentAt !== undefined ? { humanIdleWarningSentAt: data.humanIdleWarningSentAt } : {}),
      ...(data.humanLastOperatorMessageAt !== undefined ? { humanLastOperatorMessageAt: data.humanLastOperatorMessageAt } : {}),
      ...(data.humanLastPatientMessageAt !== undefined ? { humanLastPatientMessageAt: data.humanLastPatientMessageAt } : {}),
      lastInteractionAt: new Date(),
    },
  });
}

const makeProtocolNumber = () => {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const suffix = randomBytes(3).toString('hex').toUpperCase();
  return `WA-${y}${m}${d}-${suffix}`;
};

async function recordConversationMessage(params: {
  conversationId: string;
  branchId: string;
  phone: string;
  flowKey?: string | null;
  protocolNumber?: string | null;
  authorType: 'PATIENT' | 'BOT' | 'OPERATOR' | 'SYSTEM';
  authorUserId?: string | null;
  authorName?: string | null;
  message: string;
  providerMessageId?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  const normalizedMessage = String(params.message || '').trim();
  if (!normalizedMessage) return null;
  const normalizedProtocolNumber = String(params.protocolNumber || '').trim();
  const baseMetadata = (params.metadata && typeof params.metadata === 'object')
    ? { ...params.metadata }
    : {};
  const mergedMetadata = normalizedProtocolNumber
    ? { ...baseMetadata, protocolNumber: normalizedProtocolNumber }
    : baseMetadata;
  const hasMetadata = Object.keys(mergedMetadata).length > 0;

  const savedMessage = await prisma.whatsAppConversationMessage.create({
    data: {
      conversationId: params.conversationId,
      branchId: params.branchId,
      phone: formatPhoneForLookup(params.phone),
      flowKey: params.flowKey || null,
      authorType: params.authorType,
      authorUserId: params.authorUserId || null,
      authorName: params.authorName || null,
      providerMessageId: params.providerMessageId || null,
      metadata: hasMetadata ? mergedMetadata : undefined,
      message: normalizedMessage,
    },
  });

  if (params.authorType === 'PATIENT' && params.metadata?.mediaType) {
    await prisma.whatsAppConversationMedia.create({
      data: {
        conversationId: params.conversationId,
        branchId: params.branchId,
        phone: formatPhoneForLookup(params.phone),
        mediaType: String(params.metadata.mediaType),
        mediaUrl: params.metadata.mediaUrl ? String(params.metadata.mediaUrl) : null,
        fileName: params.metadata.fileName ? String(params.metadata.fileName) : null,
        mimeType: params.metadata.mimeType ? String(params.metadata.mimeType) : null,
        mediaId: params.metadata.mediaId ? String(params.metadata.mediaId) : null,
        providerMessageId: params.providerMessageId || null,
      },
    });
  }

  return savedMessage;
}

async function listInsuranceOptions(branchId: string, serviceType: 'CONSULTA' | 'EXAME') {
  // Insurances that have at least one active procedure of the given serviceType linked
  const linkedInsurances = await prisma.insurance.findMany({
    where: {
      isActive: true,
      AND: [{ OR: [{ branchId }, { branchId: null }, { branchId: '' }] }],
      insuranceProcedures: {
        some: {
          isActive: true,
          procedure: { branchId, isActive: true, appointmentType: { equals: serviceType, mode: 'insensitive' } },
        },
      },
    },
    select: { name: true },
    orderBy: { name: 'asc' },
  });

  const insuranceNames = linkedInsurances.length > 0
    ? linkedInsurances.map((i: any) => String(i.name || '').trim()).filter(Boolean)
    : (await prisma.insurance.findMany({
      where: { AND: [{ OR: [{ branchId }, { branchId: null }, { branchId: '' }] }], isActive: true },
      select: { name: true },
      orderBy: { name: 'asc' },
    })).map((item: any) => String(item.name || '').trim()).filter(Boolean);

  return insuranceNames
    .map((name: string) => ({ value: name, label: name }))
    .concat({ value: '__HANDOFF__', label: 'Não encontrei o meu convênio' });
}

async function listProcedureOptions(branchId: string, serviceType: 'CONSULTA' | 'EXAME', insurance: string) {
  const normalizedInsurance = normalizeText(insurance);

  if (normalizedInsurance) {
    // Find procedures linked to the matched insurance
    const insuranceRecord = await prisma.insurance.findFirst({
      where: {
        isActive: true,
        AND: [{ OR: [{ branchId }, { branchId: null }, { branchId: '' }] }],
        name: { equals: insurance, mode: 'insensitive' },
      },
      select: { id: true },
    });

    if (insuranceRecord) {
      const links = await prisma.insuranceProcedure.findMany({
        where: {
          insuranceId: insuranceRecord.id,
          isActive: true,
          procedure: { branchId, isActive: true, appointmentType: { equals: serviceType, mode: 'insensitive' } },
        },
        select: { procedure: { select: { id: true, name: true } } },
        orderBy: { procedure: { name: 'asc' } },
      });

      return links
        .map((l: any) => ({ value: String(l.procedure.id), label: String(l.procedure.name) }))
        .concat({ value: '__HANDOFF__', label: 'Não encontrei o meu procedimento' });
    }
  }

  // Fallback: list all active procedures of the service type
  const procedures = await prisma.procedure.findMany({
    where: { branchId, isActive: true, appointmentType: { equals: serviceType, mode: 'insensitive' } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  return procedures
    .map((p: any) => ({ value: String(p.id), label: String(p.name) }))
    .concat({ value: '__HANDOFF__', label: 'Não encontrei o meu procedimento' });
}

async function getProcedureById(branchId: string, procedureId: string) {
  return prisma.procedure.findFirst({
    where: {
      id: procedureId,
      branchId,
      isActive: true,
    },
    select: {
      id: true,
      name: true,
      durationMinutes: true,
      price: true,
    },
  });
}

async function findPrivateProcedureMatch(params: {
  branchId: string;
  serviceType: 'CONSULTA' | 'EXAME';
  query: string;
}) {
  const normalizedQuery = normalizeText(params.query);
  if (!normalizedQuery) return null;

  const procedures = await prisma.procedure.findMany({
    where: {
      branchId: params.branchId,
      isActive: true,
      appointmentType: { equals: params.serviceType, mode: 'insensitive' },
      insurances: { none: { isActive: true } },
    },
    select: {
      id: true,
      name: true,
      price: true,
      durationMinutes: true,
    },
    orderBy: { name: 'asc' },
  });

  const scored = procedures
    .map((procedure: any) => {
      const normalizedName = normalizeText(procedure.name);
      let score = 0;
      if (normalizedName === normalizedQuery) score += 100;
      if (normalizedName.includes(normalizedQuery)) score += 80;
      if (normalizedQuery.includes(normalizedName)) score += 60;

      const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
      const nameTokens = normalizedName.split(/\s+/).filter(Boolean);
      score += queryTokens.filter((token) => nameTokens.some((nameToken) => nameToken.includes(token))).length * 10;

      return {
        ...procedure,
        score,
      };
    })
    .filter((item: any) => item.score > 0);

  scored.sort((a: any, b: any) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR');
  });

  const bestMatch = scored[0];
  if (!bestMatch) return null;

  return {
    id: String(bestMatch.id),
    name: String(bestMatch.name),
    price: bestMatch.price != null ? Number(bestMatch.price) : null,
    durationMinutes: bestMatch.durationMinutes != null ? Number(bestMatch.durationMinutes) : null,
  };
}

async function listProcedureDoctors(branchId: string, procedureId: string) {
  const links = await prisma.procedureDoctor.findMany({
    where: { procedureId },
    select: { doctorId: true },
  });

  const doctorIds = Array.from(new Set(
    links.map((item: any) => String(item.doctorId || '').trim()).filter(Boolean),
  ));

  if (!doctorIds.length) return [];

  return prisma.doctor.findMany({
    where: {
      id: { in: doctorIds },
      branchId,
      isActive: true,
    },
    select: {
      id: true,
      name: true,
      workingDays: true,
      workingHoursStart: true,
      workingHoursEnd: true,
      workingSchedules: true,
    },
    orderBy: { name: 'asc' },
  });
}

async function findNextAvailableSlot(params: {
  branchId: string;
  patientId?: string | null;
  procedureId: string;
  startDateIso?: string | null;
}) {
  const procedure = await getProcedureById(params.branchId, params.procedureId);
  if (!procedure) return null;

  const doctors = await listProcedureDoctors(params.branchId, params.procedureId);
  if (!doctors.length) return null;

  const durationMinutes = resolveDurationMinutes(procedure.durationMinutes);
  const startDate = params.startDateIso
    ? new Date(`${params.startDateIso}T00:00:00`)
    : new Date();
  startDate.setHours(0, 0, 0, 0);

  for (let offset = 0; offset < DEFAULT_SEARCH_DAYS; offset += 1) {
    const candidateDate = new Date(startDate);
    candidateDate.setDate(candidateDate.getDate() + offset);
    const dateIso = formatDateIso(candidateDate);
    const weekdayToken = JS_DAY_TO_WEEKDAY[candidateDate.getDay()];

    const [doctorAppointments, patientAppointments] = await Promise.all([
      prisma.appointment.findMany({
        where: {
          branchId: params.branchId,
          isActive: true,
          date: dateIso,
          status: { in: Array.from(OPEN_APPOINTMENT_STATUSES) },
        },
        select: {
          id: true,
          doctorName: true,
          time: true,
          durationMinutes: true,
        },
      }),
      params.patientId
        ? prisma.appointment.findMany({
          where: {
            patientId: params.patientId,
            isActive: true,
            date: dateIso,
            status: { in: Array.from(OPEN_APPOINTMENT_STATUSES) },
          },
          select: {
            id: true,
            time: true,
            durationMinutes: true,
          },
        })
        : Promise.resolve([]),
    ]);

    const now = new Date();
    const isToday = formatDateIso(now) === dateIso;
    const nowMinutes = (now.getHours() * 60) + now.getMinutes();

    for (const doctor of doctors) {
      const windows = parseDoctorWindows(doctor).filter((window) => window.weekdays.includes(weekdayToken));
      for (const window of windows) {
        const slots = buildWindowSlots(window.hoursStart, window.hoursEnd, 15);
        for (const slot of slots) {
          if (isToday && timeToMinutes(slot) <= nowMinutes) continue;

          const endsWithinWindow = !window.hoursEnd || (timeToMinutes(slot) + durationMinutes) <= timeToMinutes(window.hoursEnd);
          if (!endsWithinWindow) continue;

          const doctorConflict = doctorAppointments.some((item: any) => (
            String(item.doctorName || '').trim() === String(doctor.name || '').trim()
            && item.time
            && timeRangesOverlap(slot, durationMinutes, String(item.time), resolveDurationMinutes(item.durationMinutes))
          ));

          if (doctorConflict) continue;

          const patientConflict = patientAppointments.some((item: any) => (
            item.time
            && timeRangesOverlap(slot, durationMinutes, String(item.time), resolveDurationMinutes(item.durationMinutes))
          ));

          if (patientConflict) continue;

          return {
            doctorId: String(doctor.id),
            doctorName: String(doctor.name),
            date: dateIso,
            time: slot,
            durationMinutes,
          } satisfies SlotSuggestion;
        }
      }
    }
  }

  return null;
}

async function openHumanHandoffConversation(params: {
  conversationId: string;
  branchId: string;
  branchName?: string | null;
  phone: string;
  patientName?: string | null;
  flowKey: string;
  flowLabel: string;
  description: string;
}) {
  const protocolNumber = makeProtocolNumber();
  const now = new Date();
  await saveConversation(params.conversationId, {
    state: 'HANDED_OFF',
    humanStatus: 'QUEUED',
    humanFlowKey: params.flowKey,
    humanFlowLabel: params.flowLabel,
    humanAssignedUserId: null,
    humanAssignedUserName: null,
    humanAssignedAt: null,
    humanClosedAt: null,
    humanClosedByUserId: null,
    humanClosedByUserName: null,
    humanProtocolNumber: protocolNumber,
    humanProtocolStartedAt: now,
    humanProtocolClosedAt: null,
    humanIdleWarningSentAt: null,
    humanLastOperatorMessageAt: null,
    humanLastPatientMessageAt: null,
  });

  await recordConversationMessage({
    conversationId: params.conversationId,
    branchId: params.branchId,
    phone: params.phone,
    flowKey: params.flowKey,
    protocolNumber,
    authorType: 'SYSTEM',
    authorName: 'Sistema',
    message: `[Protocolo ${protocolNumber}] Conversa encaminhada para atendimento humano.\n[Fila humana] ${params.flowLabel}\n${params.description}`,
  });

  return {
    id: params.conversationId,
    protocolNumber,
  };
}

async function reserveAppointment(params: {
  branchId: string;
  conversationId: string;
  patient: PatientLookup | null;
  patientName: string | null;
  phone: string;
  insurance: string;
  procedureName: string;
  preferredDate?: string | null;
  slot: SlotSuggestion;
  cpf: string | null;
}) {
  const observationLines = [
    '[WhatsApp BOT] Agendamento criado automaticamente e enviado para o pré-atendimento.',
    `Telefone: ${formatPhoneForLookup(params.phone)}`,
    `Convênio: ${params.insurance}`,
    `Procedimento: ${params.procedureName}`,
    `Profissional sugerido: ${params.slot.doctorName}`,
  ];

  if (params.preferredDate) {
    observationLines.push(`Preferência informada pelo paciente: ${params.preferredDate}`);
  }

  if (!params.patient?.id) {
    observationLines.push('Paciente ainda não vinculado ao cadastro da filial.');
  }

  const publicToken = randomBytes(24).toString('hex');

  const created = await prisma.$transaction(async (tx: any) => {
    const appointment = await tx.appointment.create({
      data: {
        branchId: params.branchId,
        patientId: params.patient?.id || null,
        patientName: params.patientName,
        patientCpf: params.cpf || params.patient?.cpf || null,
        doctorName: params.slot.doctorName,
        specialty: params.procedureName,
        convenio: params.insurance,
        date: params.slot.date,
        time: params.slot.time,
        durationMinutes: params.slot.durationMinutes,
        type: 'WHATSAPP',
        status: 'CONFIRMADO',
        authorizationStatus: 'PENDING',
        observations: observationLines.join('\n'),
      },
    });

    await tx.preSchedulingFlow.create({
      data: {
        branchId: params.branchId,
        appointmentId: appointment.id,
        patientId: params.patient?.id || null,
        patientName: params.patientName,
        patientCpf: params.cpf || params.patient?.cpf || null,
        patientPhone: formatPhoneForLookup(params.phone),
        source: 'BOT',
        status: 'PENDING',
        publicToken,
      },
    });

    return appointment;
  });

  await prisma.whatsAppConversationMedia.updateMany({
    where: { conversationId: params.conversationId, appointmentId: null },
    data: { appointmentId: created.id },
  });

  return created;
}

async function ensurePatientForConversation(params: {
  branchId: string;
  patient: PatientLookup | null;
  patientName: string | null;
  phone: string;
  cpf: string | null;
  birthDate: string | null;
  insuranceName?: string | null;
}) {
  if (params.patient?.id) return params.patient;
  if (!params.cpf || !params.patientName || !params.birthDate) return params.patient;

  const existing = await prisma.patient.findFirst({
    where: {
      branchId: params.branchId,
      cpf: params.cpf,
      isActive: true,
    },
    select: {
      id: true,
      name: true,
      cpf: true,
      healthInsuranceName: true,
    },
  });

  if (existing) {
    await prisma.patient.update({
      where: { id: existing.id },
      data: {
        cellphone: formatPhoneForLookup(params.phone),
        phone: formatPhoneForLookup(params.phone),
        healthInsuranceName: params.insuranceName || existing.healthInsuranceName || null,
        hasHealthInsurance: Boolean(params.insuranceName),
      },
    });

    return {
      id: String(existing.id),
      name: existing.name || null,
      cpf: existing.cpf || null,
      healthInsuranceName: params.insuranceName || existing.healthInsuranceName || null,
    } satisfies PatientLookup;
  }

  const created = await prisma.patient.create({
    data: {
      branchId: params.branchId,
      name: params.patientName,
      cpf: params.cpf,
      cellphone: formatPhoneForLookup(params.phone),
      phone: formatPhoneForLookup(params.phone),
      birthDate: new Date(`${params.birthDate}T00:00:00`),
      hasHealthInsurance: Boolean(params.insuranceName),
      healthInsuranceName: params.insuranceName || null,
      observations: '[WhatsApp BOT] Cadastro criado automaticamente durante o fluxo de agendamento.',
    },
  });

  return {
    id: String(created.id),
    name: created.name || null,
    cpf: created.cpf || null,
    healthInsuranceName: created.healthInsuranceName || null,
  } satisfies PatientLookup;
}

const buildFinalSummary = (conversation: any, context: ConversationContext, patient: PatientLookup | null) => {
  const patientName = patient?.name || conversation.patientName || context.nameCandidate || 'Não informado';
  const cpf = context.cpfCandidate || patient?.cpf || 'Não informado';
  const isNewPatient = !patient?.id && !conversation.patientId;

  return buildYesNoMessage(
    [
      'Confirma os dados abaixo?',
      `Paciente: ${patientName}`,
      `CPF: ${cpf !== 'Não informado' ? formatCpf(cpf) : cpf}`,
      `Unidade: ${context.selectedBranchName || 'Não informada'}`,
      ...(isNewPatient ? [
        `Data de nascimento: ${formatBirthDateLabel(context.birthDateCandidate)}`,
      ] : []),
      `Tipo: ${context.serviceType === 'EXAME' ? 'Marcação de exame' : 'Marcação de consulta'}`,
      `Convênio: ${context.selectedInsurance || 'Não informado'}`,
      `Procedimento: ${context.selectedProcedureName || 'Não informado'}`,
      ...(context.selectedProcedurePrice != null ? [`Valor: ${formatCurrency(context.selectedProcedurePrice)}`] : []),
      `Profissional: ${context.selectedDoctorName || 'Não informado'}`,
      `Data: ${context.suggestedDate ? formatDateLabel(context.suggestedDate) : 'Não informada'}`,
      `Hora: ${context.suggestedTime || 'Não informada'}`,
    ].join('\n'),
  );
};

async function processFlow(params: {
  branchConfig: BranchConfig;
  conversation: any;
  patient: PatientLookup | null;
  input: ChatbotInput;
}) {
  const { branchConfig, conversation, patient, input } = params;
  const text = String(input.text || '').trim();
  let context = parseJsonContext(conversation.context);
  const getTargetBranchId = () => context.selectedBranchId || branchConfig.branchId;
  const getTargetBranchName = () => context.selectedBranchName || branchConfig.branchName || null;

  if (!text) {
    return { handled: false } satisfies ChatbotResult;
  }

  if (
    shouldGoBackConversation(text)
    && conversation.state !== 'MENU'
    && conversation.state !== 'COMPLETED'
    && conversation.state !== 'HANDED_OFF'
  ) {
    const restored = restorePreviousStep(context);
    const response = restored?.response || buildMenuMessage(patient?.name || conversation.patientName || null);
    await saveConversation(conversation.id, {
      state: restored?.state || 'AWAITING_SERVICE',
      selectedService: restored?.state === 'AWAITING_SERVICE' ? null : conversation.selectedService,
      context: restored?.context || {},
      lastInboundMessage: text,
      lastOutboundMessage: response.text,
      patientId: patient?.id || conversation.patientId || null,
      patientName: patient?.name || conversation.patientName || null,
    });
    return { handled: true, response };
  }

  if (
    shouldResetConversation(text)
    || isConversationExpired(conversation.lastInteractionAt)
    || conversation.state === 'MENU'
    || conversation.state === 'COMPLETED'
    || conversation.state === 'HANDED_OFF'
  ) {
    const response = buildMenuMessage(patient?.name || conversation.patientName || null);
    await saveConversation(conversation.id, {
      state: 'AWAITING_SERVICE',
      selectedService: null,
      context: {},
      lastInboundMessage: text,
      lastOutboundMessage: response.text,
      patientId: patient?.id || conversation.patientId || null,
      patientName: patient?.name || conversation.patientName || null,
    });
    return { handled: true, response } satisfies ChatbotResult;
  }

  switch (conversation.state) {
    case 'AWAITING_SERVICE': {
      const selected = parseServiceType(text);
      if (!selected) {
        const response = buildMenuMessage(patient?.name || conversation.patientName || null);
        await saveConversation(conversation.id, {
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      if (selected === 'NEXT_APPOINTMENTS') {
        if (!patient?.id && !patient?.cpf) {
          const response = {
            text: 'Não consegui identificar seu cadastro pelo número deste WhatsApp para consultar próximas consultas ou exames. Se preferir, você pode seguir com o menu normalmente ou pedir ajuda para um atendente.',
          };
          await saveConversation(conversation.id, {
            state: 'AWAITING_SERVICE',
            selectedService: null,
            context: {},
            lastInboundMessage: text,
            lastOutboundMessage: response.text,
            patientId: patient?.id || conversation.patientId || null,
            patientName: patient?.name || conversation.patientName || null,
          });
          return { handled: true, response };
        }

        const nextAppointment = await findNextAppointmentForPatient({
          referenceBranchId: context.selectedBranchId || branchConfig.branchId,
          patient,
        });

        const response = nextAppointment
          ? {
            text: buildNextAppointmentMessage({
              patientName: patient?.name || conversation.patientName || null,
              appointment: nextAppointment,
            }),
          }
          : {
            text: patient?.name
              ? `Não encontrei próximas consultas ou exames agendados no momento para você, ${patient.name}.`
              : 'Não encontrei próximas consultas ou exames agendados no momento para você.',
          };

        await saveConversation(conversation.id, {
          state: 'AWAITING_SERVICE',
          selectedService: null,
          context: {},
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
          patientId: patient?.id || conversation.patientId || null,
          patientName: patient?.name || conversation.patientName || null,
        });
        return { handled: true, response };
      }

      if (selected === 'DUVIDAS') {
        const ticket = await openHumanHandoffConversation({
          conversationId: conversation.id,
          branchId: branchConfig.branchId,
          branchName: branchConfig.branchName,
          phone: input.phone,
          patientName: patient?.name || conversation.patientName || null,
          flowKey: 'DUVIDAS',
          flowLabel: 'Dúvidas',
          description: 'Paciente solicitou atendimento humano pelo fluxo de dúvidas do WhatsApp.',
        });

        const response = buildHumanHandoffMessage(ticket.protocolNumber);
        await saveConversation(conversation.id, {
          state: 'HANDED_OFF',
          selectedService: 'DUVIDAS',
          handoffTicketId: ticket.id,
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      context = {
        serviceType: selected,
      };

      context = pushHistoryEntry(
        context,
        'AWAITING_SERVICE',
        buildMenuMessage(patient?.name || conversation.patientName || null),
      );
      const unitOptions = await listUnitOptions(branchConfig.branchId);
      const response: ChatbotResponse = {
        text: 'Qual unidade você deseja?',
        listOptions: toListOptions(unitOptions, 'Ver unidades', 'Unidades disponíveis'),
      };
      context.options = unitOptions;
      context.lastPrompt = response.text;
      await saveConversation(conversation.id, {
        state: 'AWAITING_UNIT',
        selectedService: selected,
        context,
        lastInboundMessage: text,
        lastOutboundMessage: response.text,
      });
      return { handled: true, response };
    }

    case 'AWAITING_UNIT': {
      const selected = resolveOptionSelection(text, context.options || []);
      if (!selected) {
        const response = { text: context.lastPrompt || 'Qual unidade você deseja?' };
        await saveConversation(conversation.id, {
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      context = pushHistoryEntry(
        context,
        'AWAITING_UNIT',
        context.lastPrompt || 'Qual unidade você deseja?',
      );
      context.selectedBranchId = selected.value;
      context.selectedBranchName = selected.label;

      const patientAtSelectedUnit = await lookupPatient(selected.value, input.phone);

      if (patientAtSelectedUnit?.healthInsuranceName) {
        context.selectedInsurance = patientAtSelectedUnit.healthInsuranceName;
        const procedureOptions = await listProcedureOptions(selected.value, context.serviceType || 'CONSULTA', patientAtSelectedUnit.healthInsuranceName);
        const response: ChatbotResponse = {
          text: `Certo. Na unidade ${selected.label}, encontrei o convênio ${patientAtSelectedUnit.healthInsuranceName} no seu cadastro.\n\nQual procedimento você deseja?`,
          listOptions: toListOptions(procedureOptions, 'Ver procedimentos', 'Procedimentos disponíveis'),
        };
        context.options = procedureOptions;
        context.lastPrompt = response.text;
        await saveConversation(conversation.id, {
          state: 'AWAITING_PROCEDURE',
          context,
          patientId: patientAtSelectedUnit.id,
          patientName: patientAtSelectedUnit.name,
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      const insuranceOptions = await listInsuranceOptions(selected.value, context.serviceType || 'CONSULTA');
      const response: ChatbotResponse = {
        text: `Qual é o seu convênio na unidade ${selected.label}?`,
        listOptions: toListOptions(insuranceOptions, 'Ver convênios', 'Convênios disponíveis'),
      };
      context.options = insuranceOptions;
      context.lastPrompt = response.text;
      await saveConversation(conversation.id, {
        state: 'AWAITING_INSURANCE',
        context,
        patientId: patientAtSelectedUnit?.id || null,
        patientName: patientAtSelectedUnit?.name || null,
        lastInboundMessage: text,
        lastOutboundMessage: response.text,
      });
      return { handled: true, response };
    }

    case 'AWAITING_INSURANCE': {
      const selected = resolveOptionSelection(text, context.options || []);
      if (!selected) {
        const response = { text: context.lastPrompt || 'Qual é o seu convênio?' };
        await saveConversation(conversation.id, {
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      if (selected.value === '__HANDOFF__') {
        const ticket = await openHumanHandoffConversation({
          conversationId: conversation.id,
          branchId: getTargetBranchId(),
          branchName: getTargetBranchName(),
          phone: input.phone,
          patientName: patient?.name || conversation.patientName || null,
          flowKey: 'CONVENIO_NAO_ENCONTRADO',
          flowLabel: 'Convênio não encontrado',
          description: `Fluxo: ${context.serviceType}\nPaciente não encontrou o convênio na lista automática.`,
        });

        const response = buildHumanHandoffMessage(ticket.protocolNumber);
        await saveConversation(conversation.id, {
          state: 'HANDED_OFF',
          handoffTicketId: ticket.id,
          context: {
            ...context,
            options: [],
            lastPrompt: response.text,
          },
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      context = pushHistoryEntry(
        context,
        'AWAITING_INSURANCE',
        context.lastPrompt || 'Qual é o seu convênio?',
      );
      context.selectedInsurance = selected.label;
      const procedureOptions = await listProcedureOptions(getTargetBranchId(), context.serviceType || 'CONSULTA', selected.label);
      const response: ChatbotResponse = {
        text: 'Qual procedimento você deseja?',
        listOptions: toListOptions(procedureOptions, 'Ver procedimentos', 'Procedimentos disponíveis'),
      };
      context.options = procedureOptions;
      context.lastPrompt = response.text;

      await saveConversation(conversation.id, {
        state: 'AWAITING_PROCEDURE',
        context,
        lastInboundMessage: text,
        lastOutboundMessage: response.text,
      });
      return { handled: true, response };
    }

    case 'AWAITING_PROCEDURE': {
      const selected = resolveOptionSelection(text, context.options || []);
      if (!selected) {
        const response = { text: context.lastPrompt || 'Qual procedimento você deseja?' };
        await saveConversation(conversation.id, {
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      if (selected.value === '__HANDOFF__') {
        context = pushHistoryEntry(
          context,
          'AWAITING_PROCEDURE',
          context.lastPrompt || 'Qual procedimento você deseja?',
        );
        const response: ChatbotResponse = {
          text: 'Tudo bem. O que você deseja fazer agora?',
          listOptions: {
            buttonTitle: 'Ver opções',
            options: [
              { title: 'Falar com atendente', postbackText: '1' },
              { title: 'Consultar no particular', postbackText: '2' },
            ],
          },
        };
        await saveConversation(conversation.id, {
          state: 'AWAITING_PROCEDURE_NOT_FOUND_ACTION',
          context: {
            ...context,
            options: [],
            lastPrompt: response.text,
          },
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      context = pushHistoryEntry(
        context,
        'AWAITING_PROCEDURE',
        context.lastPrompt || 'Qual procedimento você deseja?',
      );
      const procedure = await getProcedureById(getTargetBranchId(), selected.value);
      if (!procedure) {
        const ticket = await openHumanHandoffConversation({
          conversationId: conversation.id,
          branchId: getTargetBranchId(),
          branchName: getTargetBranchName(),
          phone: input.phone,
          patientName: patient?.name || conversation.patientName || null,
          flowKey: 'PROCEDIMENTO_INVALIDO',
          flowLabel: 'Procedimento inválido',
          description: `Fluxo: ${context.serviceType}\nConvênio: ${context.selectedInsurance || 'Não informado'}\nProcedimento selecionado não foi encontrado no cadastro.`,
        });
        const response = buildHumanHandoffMessage(ticket.protocolNumber);
        await saveConversation(conversation.id, {
          state: 'HANDED_OFF',
          handoffTicketId: ticket.id,
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      const slot = await findNextAvailableSlot({
        branchId: getTargetBranchId(),
        patientId: patient?.id || conversation.patientId || null,
        procedureId: procedure.id,
      });

      if (!slot) {
        const ticket = await openHumanHandoffConversation({
          conversationId: conversation.id,
          branchId: getTargetBranchId(),
          branchName: getTargetBranchName(),
          phone: input.phone,
          patientName: patient?.name || conversation.patientName || null,
          flowKey: 'SEM_HORARIO_AUTOMATICO',
          flowLabel: 'Sem horário automático',
          description: `Fluxo: ${context.serviceType}\nConvênio: ${context.selectedInsurance || 'Não informado'}\nProcedimento: ${procedure.name}`,
        });
        const response = buildHumanHandoffMessage(ticket.protocolNumber);
        await saveConversation(conversation.id, {
          state: 'HANDED_OFF',
          handoffTicketId: ticket.id,
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      context.selectedProcedureId = procedure.id;
      context.selectedProcedureName = procedure.name;
      context.selectedProcedurePrice = procedure.price != null ? Number(procedure.price) : null;
      context.selectedDoctorId = slot.doctorId;
      context.selectedDoctorName = slot.doctorName;
      context.suggestedDate = slot.date;
      context.suggestedTime = slot.time;
      context.suggestedDurationMinutes = slot.durationMinutes;
      context.options = [];
      const response = buildYesNoMessage(
        `Encontrei este horário mais próximo para ${procedure.name}:\n` +
        `Data: ${formatDateLabel(slot.date)}\n` +
        `Hora: ${slot.time}\n` +
        `Profissional: ${slot.doctorName}\n\n` +
        'Deseja seguir com esse horário?',
      );
      context.lastPrompt = response.text;

      await saveConversation(conversation.id, {
        state: 'AWAITING_SLOT_CONFIRMATION',
        context,
        lastInboundMessage: text,
        lastOutboundMessage: response.text,
      });
      return { handled: true, response };
    }

    case 'AWAITING_PROCEDURE_NOT_FOUND_ACTION': {
      const action = parseProcedureNotFoundAction(text);
      if (!action) {
        const response: ChatbotResponse = {
          text: context.lastPrompt || 'O que você deseja fazer agora?',
          listOptions: {
            buttonTitle: 'Ver opções',
            options: [
              { title: 'Falar com atendente', postbackText: '1' },
              { title: 'Consultar no particular', postbackText: '2' },
            ],
          },
        };
        await saveConversation(conversation.id, {
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      if (action === 'HANDOFF') {
        const ticket = await openHumanHandoffConversation({
          conversationId: conversation.id,
          branchId: getTargetBranchId(),
          branchName: getTargetBranchName(),
          phone: input.phone,
          patientName: patient?.name || conversation.patientName || null,
          flowKey: 'PROCEDIMENTO_NAO_ENCONTRADO',
          flowLabel: 'Procedimento não encontrado',
          description: `Fluxo: ${context.serviceType}\nConvênio: ${context.selectedInsurance || 'Não informado'}\nPaciente não encontrou o procedimento na lista automática.`,
        });

        const response = buildHumanHandoffMessage(ticket.protocolNumber);
        await saveConversation(conversation.id, {
          state: 'HANDED_OFF',
          handoffTicketId: ticket.id,
          context: {
            ...context,
            lastPrompt: response.text,
          },
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      const response = { text: 'Certo. Qual procedimento você deseja consultar no particular?' };
      await saveConversation(conversation.id, {
        state: 'AWAITING_PRIVATE_PROCEDURE_INPUT',
        context: {
          ...context,
          privateProcedureSearchText: null,
          privateProcedureSearchAttempts: context.privateProcedureSearchAttempts || 0,
          privateProcedureMatchId: null,
          privateProcedureMatchName: null,
          privateProcedureMatchPrice: null,
          lastPrompt: response.text,
        },
        lastInboundMessage: text,
        lastOutboundMessage: response.text,
      });
      return { handled: true, response };
    }

    case 'AWAITING_PRIVATE_PROCEDURE_INPUT': {
      const typedProcedure = String(text || '').trim();
      if (typedProcedure.length < 3) {
        const response = { text: 'Por favor, descreva o procedimento com um pouco mais de detalhe.' };
        await saveConversation(conversation.id, {
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      context = pushHistoryEntry(
        context,
        'AWAITING_PRIVATE_PROCEDURE_INPUT',
        context.lastPrompt || 'Qual procedimento você deseja consultar no particular?',
      );
      context.privateProcedureSearchText = typedProcedure;
      const response = buildYesNoMessage(`Você quis dizer o procedimento "${typedProcedure}"?`);
      context.lastPrompt = response.text;

      await saveConversation(conversation.id, {
        state: 'AWAITING_PRIVATE_PROCEDURE_CONFIRMATION',
        context,
        lastInboundMessage: text,
        lastOutboundMessage: response.text,
      });
      return { handled: true, response };
    }

    case 'AWAITING_PRIVATE_PROCEDURE_CONFIRMATION': {
      const accepted = parseYesNo(text);
      if (accepted === null) {
        const response = { text: context.lastPrompt || 'Confirma o procedimento informado?' };
        await saveConversation(conversation.id, {
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      context = pushHistoryEntry(
        context,
        'AWAITING_PRIVATE_PROCEDURE_CONFIRMATION',
        context.lastPrompt || 'Confirma o procedimento informado?',
      );

      if (!accepted) {
        const response = { text: 'Sem problema. Digite novamente qual procedimento você deseja consultar no particular.' };
        await saveConversation(conversation.id, {
          state: 'AWAITING_PRIVATE_PROCEDURE_INPUT',
          context: {
            ...context,
            privateProcedureSearchText: null,
            privateProcedureMatchId: null,
            privateProcedureMatchName: null,
            privateProcedureMatchPrice: null,
            lastPrompt: response.text,
          },
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      const attempts = Number(context.privateProcedureSearchAttempts || 0) + 1;
      const match = await findPrivateProcedureMatch({
        branchId: getTargetBranchId(),
        serviceType: context.serviceType || 'CONSULTA',
        query: context.privateProcedureSearchText || '',
      });

      if (!match) {
        if (attempts >= 2) {
          const ticket = await openHumanHandoffConversation({
            conversationId: conversation.id,
            branchId: getTargetBranchId(),
            branchName: getTargetBranchName(),
            phone: input.phone,
            patientName: patient?.name || conversation.patientName || null,
            flowKey: 'PROCEDIMENTO_NAO_ENCONTRADO',
            flowLabel: 'Procedimento não encontrado',
            description: `Fluxo: ${context.serviceType}\nPaciente tentou consultar no particular e não encontramos correspondência para "${context.privateProcedureSearchText || 'Não informado'}".`,
          });
          const response = buildHumanHandoffMessage(ticket.protocolNumber);
          await saveConversation(conversation.id, {
            state: 'HANDED_OFF',
            handoffTicketId: ticket.id,
            context: {
              ...context,
              privateProcedureSearchAttempts: attempts,
              lastPrompt: response.text,
            },
            lastInboundMessage: text,
            lastOutboundMessage: response.text,
          });
          return { handled: true, response };
        }

        const response = { text: 'Ainda não encontrei esse procedimento no particular. Tente descrever novamente para eu buscar mais uma vez.' };
        await saveConversation(conversation.id, {
          state: 'AWAITING_PRIVATE_PROCEDURE_INPUT',
          context: {
            ...context,
            privateProcedureSearchAttempts: attempts,
            privateProcedureSearchText: null,
            privateProcedureMatchId: null,
            privateProcedureMatchName: null,
            privateProcedureMatchPrice: null,
            lastPrompt: response.text,
          },
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      const response = buildYesNoMessage(
        `Encontrei este procedimento no particular na unidade ${getTargetBranchName() || 'selecionada'}:\n` +
        `Procedimento: ${match.name}\n` +
        `Valor: ${formatCurrency(match.price)}\n\n` +
        'Deseja seguir com ele?',
      );

      await saveConversation(conversation.id, {
        state: 'AWAITING_PRIVATE_PROCEDURE_MATCH_CONFIRMATION',
        context: {
          ...context,
          privateProcedureSearchAttempts: attempts,
          privateProcedureMatchId: match.id,
          privateProcedureMatchName: match.name,
          privateProcedureMatchPrice: match.price,
          lastPrompt: response.text,
        },
        lastInboundMessage: text,
        lastOutboundMessage: response.text,
      });
      return { handled: true, response };
    }

    case 'AWAITING_PRIVATE_PROCEDURE_MATCH_CONFIRMATION': {
      const accepted = parseYesNo(text);
      if (accepted === null) {
        const response = { text: context.lastPrompt || 'Deseja seguir com o procedimento particular encontrado?' };
        await saveConversation(conversation.id, {
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      context = pushHistoryEntry(
        context,
        'AWAITING_PRIVATE_PROCEDURE_MATCH_CONFIRMATION',
        context.lastPrompt || 'Deseja seguir com o procedimento particular encontrado?',
      );

      if (!accepted) {
        if (Number(context.privateProcedureSearchAttempts || 0) >= 2) {
          const ticket = await openHumanHandoffConversation({
            conversationId: conversation.id,
            branchId: getTargetBranchId(),
            branchName: getTargetBranchName(),
            phone: input.phone,
            patientName: patient?.name || conversation.patientName || null,
            flowKey: 'PROCEDIMENTO_NAO_ENCONTRADO',
            flowLabel: 'Procedimento não encontrado',
            description: `Fluxo: ${context.serviceType}\nPaciente recusou o procedimento particular sugerido após as tentativas automáticas.`,
          });
          const response = buildHumanHandoffMessage(ticket.protocolNumber);
          await saveConversation(conversation.id, {
            state: 'HANDED_OFF',
            handoffTicketId: ticket.id,
            context: {
              ...context,
              lastPrompt: response.text,
            },
            lastInboundMessage: text,
            lastOutboundMessage: response.text,
          });
          return { handled: true, response };
        }

        const response = { text: 'Sem problema. Digite novamente qual procedimento você deseja consultar no particular.' };
        await saveConversation(conversation.id, {
          state: 'AWAITING_PRIVATE_PROCEDURE_INPUT',
          context: {
            ...context,
            privateProcedureSearchText: null,
            privateProcedureMatchId: null,
            privateProcedureMatchName: null,
            privateProcedureMatchPrice: null,
            lastPrompt: response.text,
          },
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      const procedure = context.privateProcedureMatchId
        ? await getProcedureById(getTargetBranchId(), context.privateProcedureMatchId)
        : null;

      if (!procedure) {
        const ticket = await openHumanHandoffConversation({
          conversationId: conversation.id,
          branchId: getTargetBranchId(),
          branchName: getTargetBranchName(),
          phone: input.phone,
          patientName: patient?.name || conversation.patientName || null,
          flowKey: 'PROCEDIMENTO_INVALIDO',
          flowLabel: 'Procedimento inválido',
          description: `Fluxo: ${context.serviceType}\nPaciente aceitou o procedimento particular, mas ele não foi encontrado no cadastro.`,
        });
        const response = buildHumanHandoffMessage(ticket.protocolNumber);
        await saveConversation(conversation.id, {
          state: 'HANDED_OFF',
          handoffTicketId: ticket.id,
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      const slot = await findNextAvailableSlot({
        branchId: getTargetBranchId(),
        patientId: patient?.id || conversation.patientId || null,
        procedureId: procedure.id,
      });

      if (!slot) {
        const ticket = await openHumanHandoffConversation({
          conversationId: conversation.id,
          branchId: getTargetBranchId(),
          branchName: getTargetBranchName(),
          phone: input.phone,
          patientName: patient?.name || conversation.patientName || null,
          flowKey: 'SEM_HORARIO_AUTOMATICO',
          flowLabel: 'Sem horário automático',
          description: `Fluxo: ${context.serviceType}\nConvênio: Particular\nProcedimento: ${procedure.name}`,
        });
        const response = buildHumanHandoffMessage(ticket.protocolNumber);
        await saveConversation(conversation.id, {
          state: 'HANDED_OFF',
          handoffTicketId: ticket.id,
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      context.selectedInsurance = 'Particular';
      context.selectedProcedureId = procedure.id;
      context.selectedProcedureName = procedure.name;
      context.selectedProcedurePrice = procedure.price != null ? Number(procedure.price) : (context.privateProcedureMatchPrice ?? null);
      context.selectedDoctorId = slot.doctorId;
      context.selectedDoctorName = slot.doctorName;
      context.suggestedDate = slot.date;
      context.suggestedTime = slot.time;
      context.suggestedDurationMinutes = slot.durationMinutes;
      context.options = [];
      const response = buildYesNoMessage(
        `Encontrei este horário mais próximo para ${procedure.name} no particular:\n` +
        `Valor: ${formatCurrency(context.selectedProcedurePrice)}\n` +
        `Data: ${formatDateLabel(slot.date)}\n` +
        `Hora: ${slot.time}\n` +
        `Profissional: ${slot.doctorName}\n\n` +
        'Deseja seguir com esse horário?',
      );
      context.lastPrompt = response.text;

      await saveConversation(conversation.id, {
        state: 'AWAITING_SLOT_CONFIRMATION',
        context,
        lastInboundMessage: text,
        lastOutboundMessage: response.text,
      });
      return { handled: true, response };
    }

    case 'AWAITING_SLOT_CONFIRMATION': {
      const accepted = parseYesNo(text);
      if (accepted === null) {
        const response = { text: context.lastPrompt || 'Deseja seguir com esse horário?' };
        await saveConversation(conversation.id, {
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      context = pushHistoryEntry(
        context,
        'AWAITING_SLOT_CONFIRMATION',
        context.lastPrompt || 'Deseja seguir com esse horário?',
      );
      if (!accepted) {
        const response = { text: 'Certo. Qual é a sua preferência de dia? Você pode responder, por exemplo, com 15/04/2026, hoje, amanhã ou segunda.' };
        context.lastPrompt = response.text;
        await saveConversation(conversation.id, {
          state: 'AWAITING_PREFERRED_DATE',
          context,
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      if (hasCollectedNewPatientData(conversation, context, patient)) {
        const response = buildFinalSummary(conversation, context, patient);
        await saveConversation(conversation.id, {
          state: 'AWAITING_FINAL_CONFIRMATION',
          context,
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      const response = { text: 'Para continuar, informe seu CPF.' };
      context.lastPrompt = response.text;
      await saveConversation(conversation.id, {
        state: 'AWAITING_CPF',
        context,
        lastInboundMessage: text,
        lastOutboundMessage: response.text,
      });
      return { handled: true, response };
    }

    case 'AWAITING_PREFERRED_DATE': {
      const preferredDate = parsePreferredDate(text);
      if (!preferredDate) {
        const response = { text: 'Não consegui entender a data. Responda no formato DD/MM/AAAA, ou diga hoje, amanhã ou o nome do dia da semana.' };
        await saveConversation(conversation.id, {
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      context = pushHistoryEntry(
        context,
        'AWAITING_PREFERRED_DATE',
        context.lastPrompt || 'Qual é a sua preferência de dia?',
      );
      const slot = context.selectedProcedureId
        ? await findNextAvailableSlot({
          branchId: getTargetBranchId(),
          patientId: patient?.id || conversation.patientId || null,
          procedureId: context.selectedProcedureId,
          startDateIso: preferredDate,
        })
        : null;

      if (!slot) {
        const ticket = await openHumanHandoffConversation({
          conversationId: conversation.id,
          branchId: getTargetBranchId(),
          branchName: getTargetBranchName(),
          phone: input.phone,
          patientName: patient?.name || conversation.patientName || null,
          flowKey: 'PREFERENCIA_SEM_DISPONIBILIDADE',
          flowLabel: 'Preferência sem disponibilidade',
          description: `Fluxo: ${context.serviceType}\nConvênio: ${context.selectedInsurance || 'Não informado'}\nProcedimento: ${context.selectedProcedureName || 'Não informado'}\nPreferência: ${preferredDate}`,
        });
        const response = buildHumanHandoffMessage(ticket.protocolNumber);
        await saveConversation(conversation.id, {
          state: 'HANDED_OFF',
          handoffTicketId: ticket.id,
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      context.preferredDate = preferredDate;
      context.selectedDoctorId = slot.doctorId;
      context.selectedDoctorName = slot.doctorName;
      context.suggestedDate = slot.date;
      context.suggestedTime = slot.time;
      context.suggestedDurationMinutes = slot.durationMinutes;
      const response = buildYesNoMessage(
        `Encontrei este horário com base na sua preferência:\n` +
        `Data: ${formatDateLabel(slot.date)}\n` +
        `Hora: ${slot.time}\n` +
        `Profissional: ${slot.doctorName}\n\n` +
        'Deseja seguir com esse horário?',
      );
      context.lastPrompt = response.text;

      await saveConversation(conversation.id, {
        state: 'AWAITING_SLOT_CONFIRMATION',
        context,
        lastInboundMessage: text,
        lastOutboundMessage: response.text,
      });
      return { handled: true, response };
    }

    case 'AWAITING_CPF': {
      const cpf = normalizeCpf(text);
      if (!isValidCpf(cpf)) {
        const response = { text: 'O CPF informado parece inválido. Por favor, envie novamente apenas com os números.' };
        await saveConversation(conversation.id, {
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      context = pushHistoryEntry(
        context,
        'AWAITING_CPF',
        context.lastPrompt || 'Para continuar, informe seu CPF.',
      );
      context.cpfCandidate = cpf;
      const response = buildYesNoMessage(`Confirma que o CPF ${formatCpf(cpf)} está correto?`);
      context.lastPrompt = response.text;
      await saveConversation(conversation.id, {
        state: 'AWAITING_CPF_CONFIRMATION',
        context,
        lastInboundMessage: text,
        lastOutboundMessage: response.text,
      });
      return { handled: true, response };
    }

    case 'AWAITING_CPF_CONFIRMATION': {
      const accepted = parseYesNo(text);
      if (accepted === null) {
        const response = { text: context.lastPrompt || 'Confirma o CPF informado?' };
        await saveConversation(conversation.id, {
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      context = pushHistoryEntry(
        context,
        'AWAITING_CPF_CONFIRMATION',
        context.lastPrompt || 'Confirma o CPF informado?',
      );
      if (!accepted) {
        const response = { text: 'Tudo bem. Informe seu CPF novamente.' };
        await saveConversation(conversation.id, {
          state: 'AWAITING_CPF',
          context: {
            ...context,
            cpfCandidate: null,
            lastPrompt: response.text,
          },
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      let resolvedPatient = patient;
      if (context.cpfCandidate) {
        const patientByCpf = await prisma.patient.findFirst({
          where: {
            branchId: getTargetBranchId(),
            cpf: context.cpfCandidate,
            isActive: true,
          },
          select: {
            id: true,
            name: true,
            cpf: true,
            healthInsuranceName: true,
          },
        });

        if (patientByCpf) {
          resolvedPatient = {
            id: String(patientByCpf.id),
            name: patientByCpf.name || null,
            cpf: patientByCpf.cpf || null,
            healthInsuranceName: patientByCpf.healthInsuranceName || null,
          };
        }
      }

      if (!resolvedPatient?.name) {
        const response = { text: 'Perfeito. Agora informe seu nome completo.' };
        await saveConversation(conversation.id, {
          state: 'AWAITING_NEW_PATIENT_NAME',
          context: {
            ...context,
            lastPrompt: response.text,
          },
          patientId: resolvedPatient?.id || null,
          patientName: resolvedPatient?.name || null,
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      const response = buildFinalSummary({
        ...conversation,
        patientName: resolvedPatient.name,
      }, context, resolvedPatient);

      await saveConversation(conversation.id, {
        state: 'AWAITING_FINAL_CONFIRMATION',
        context,
        patientId: resolvedPatient.id,
        patientName: resolvedPatient.name,
        lastInboundMessage: text,
        lastOutboundMessage: response.text,
      });
      return { handled: true, response };
    }

    case 'AWAITING_NEW_PATIENT_NAME': {
      const name = String(text || '').trim();
      if (name.length < 3) {
        const response = { text: 'Por favor, informe seu nome completo.' };
        await saveConversation(conversation.id, {
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      context = pushHistoryEntry(
        context,
        'AWAITING_NEW_PATIENT_NAME',
        context.lastPrompt || 'Perfeito. Agora informe seu nome completo.',
      );
      context.nameCandidate = name;

      if (context.birthDateCandidate) {
        const response = buildFinalSummary({
          ...conversation,
          patientName: name,
        }, context, patient);

        await saveConversation(conversation.id, {
          state: 'AWAITING_FINAL_CONFIRMATION',
          context: {
            ...context,
            lastPrompt: response.text,
          },
          patientName: name,
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      const response = { text: 'Informe sua data de nascimento no formato DD/MM/AAAA.' };

      await saveConversation(conversation.id, {
        state: 'AWAITING_NEW_PATIENT_BIRTHDATE',
        context: {
          ...context,
          lastPrompt: response.text,
        },
        patientName: name,
        lastInboundMessage: text,
        lastOutboundMessage: response.text,
      });
      return { handled: true, response };
    }

    case 'AWAITING_NEW_PATIENT_BIRTHDATE': {
      const birthDate = parseBirthDate(text);
      if (!birthDate) {
        const response = { text: 'Data inválida. Informe sua data de nascimento no formato DD/MM/AAAA.' };
        await saveConversation(conversation.id, {
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      context = pushHistoryEntry(
        context,
        'AWAITING_NEW_PATIENT_BIRTHDATE',
        context.lastPrompt || 'Informe sua data de nascimento no formato DD/MM/AAAA.',
      );
      context.birthDateCandidate = birthDate;
      const response = buildFinalSummary({
        ...conversation,
        patientName: context.nameCandidate || conversation.patientName,
      }, context, patient);

      await saveConversation(conversation.id, {
        state: 'AWAITING_FINAL_CONFIRMATION',
        context: {
          ...context,
          lastPrompt: response.text,
        },
        patientName: context.nameCandidate || conversation.patientName || null,
        lastInboundMessage: text,
        lastOutboundMessage: response.text,
      });
      return { handled: true, response };
    }

    case 'AWAITING_FINAL_CONFIRMATION': {
      const accepted = parseYesNo(text);
      if (accepted === null) {
        const response = context.lastPrompt
          ? { text: context.lastPrompt, binaryOptions: true }
          : buildFinalSummary(conversation, context, patient);
        await saveConversation(conversation.id, {
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      if (!accepted) {
        const response = {
          text: buildEditSelectionPrompt({
            patient,
            conversation,
            context,
          }),
        };
        await saveConversation(conversation.id, {
          state: 'AWAITING_CONFIRMATION_EDIT_SELECTION',
          context: {
            ...context,
            lastPrompt: response.text,
          },
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      let resolvedPatient = patient || (conversation.patientId
        ? await prisma.patient.findFirst({
          where: { id: conversation.patientId, branchId: getTargetBranchId(), isActive: true },
          select: {
            id: true,
            name: true,
            cpf: true,
            healthInsuranceName: true,
          },
        }).then((item: any) => item ? ({
          id: String(item.id),
          name: item.name || null,
          cpf: item.cpf || null,
          healthInsuranceName: item.healthInsuranceName || null,
        }) : null)
        : null);

      const slot: SlotSuggestion | null = context.suggestedDate && context.suggestedTime && context.selectedDoctorId && context.selectedDoctorName
        ? {
          doctorId: context.selectedDoctorId,
          doctorName: context.selectedDoctorName,
          date: context.suggestedDate,
          time: context.suggestedTime,
          durationMinutes: resolveDurationMinutes(context.suggestedDurationMinutes),
        }
        : null;

      if (!slot || !context.selectedProcedureName || !context.selectedInsurance || !context.serviceType) {
        const response = { text: 'Não consegui concluir o agendamento automaticamente. Por favor, envie "menu" para recomeçar.' };
        await saveConversation(conversation.id, {
          state: 'HANDED_OFF',
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      resolvedPatient = await ensurePatientForConversation({
        branchId: getTargetBranchId(),
        patient: resolvedPatient,
        patientName: resolvedPatient?.name || conversation.patientName || context.nameCandidate || null,
        phone: input.phone,
        cpf: context.cpfCandidate || resolvedPatient?.cpf || null,
        birthDate: context.birthDateCandidate || null,
        insuranceName: context.selectedInsurance || null,
      });

      const appointment = await reserveAppointment({
        branchId: getTargetBranchId(),
        conversationId: conversation.id,
        patient: resolvedPatient,
        patientName: resolvedPatient?.name || conversation.patientName || context.nameCandidate || null,
        phone: input.phone,
        insurance: context.selectedInsurance,
        procedureName: context.selectedProcedureName,
        preferredDate: context.preferredDate || null,
        slot,
        cpf: context.cpfCandidate || resolvedPatient?.cpf || null,
      });
      publishAppointmentCreatedEvent({ branchId: getTargetBranchId(), appointmentId: appointment.id });

      const response = { text: 'Sua solicitação foi registrada com sucesso e já entrou na fila de pré-atendimento da clínica.' };
      await saveConversation(conversation.id, {
        state: 'COMPLETED',
        reservedAppointmentId: appointment.id,
        patientId: resolvedPatient?.id || conversation.patientId || null,
        patientName: resolvedPatient?.name || conversation.patientName || context.nameCandidate || null,
        lastInboundMessage: text,
        lastOutboundMessage: response.text,
      });
      return { handled: true, response };
    }

    case 'AWAITING_CONFIRMATION_EDIT_SELECTION': {
      const selectedStep = parseEditableStepSelection(text);
      const isNewPatient = !patient?.id && !conversation.patientId;

      if (!selectedStep || (!isNewPatient && (selectedStep === 'NAME' || selectedStep === 'BIRTHDATE'))) {
        const response = {
          text: buildEditSelectionPrompt({
            patient,
            conversation,
            context,
          }),
        };
        await saveConversation(conversation.id, {
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      if (selectedStep === 'SERVICE') {
        const response = buildMenuMessage(patient?.name || conversation.patientName || context.nameCandidate || null);
        await saveConversation(conversation.id, {
          state: 'AWAITING_SERVICE',
          selectedService: null,
          context: {},
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      if (selectedStep === 'UNIT') {
        const unitOptions = await listUnitOptions(branchConfig.branchId);
        const response: ChatbotResponse = {
          text: 'Qual unidade você deseja?',
          listOptions: toListOptions(unitOptions, 'Ver unidades', 'Unidades disponíveis'),
        };
        await saveConversation(conversation.id, {
          state: 'AWAITING_UNIT',
          patientId: null,
          patientName: null,
          context: {
            ...context,
            selectedBranchId: null,
            selectedBranchName: null,
            selectedInsurance: null,
            selectedProcedureId: null,
            selectedProcedureName: null,
            selectedDoctorId: null,
            selectedDoctorName: null,
            suggestedDate: null,
            suggestedTime: null,
            suggestedDurationMinutes: null,
            preferredDate: null,
            options: unitOptions,
            lastPrompt: response.text,
          },
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      if (selectedStep === 'INSURANCE') {
        const insuranceOptions = await listInsuranceOptions(getTargetBranchId(), context.serviceType || 'CONSULTA');
        const response: ChatbotResponse = {
          text: 'Qual é o seu convênio?',
          listOptions: toListOptions(insuranceOptions, 'Ver convênios', 'Convênios disponíveis'),
        };
        await saveConversation(conversation.id, {
          state: 'AWAITING_INSURANCE',
          context: {
            ...context,
            selectedInsurance: null,
            selectedProcedureId: null,
            selectedProcedureName: null,
            selectedDoctorId: null,
            selectedDoctorName: null,
            suggestedDate: null,
            suggestedTime: null,
            suggestedDurationMinutes: null,
            preferredDate: null,
            options: insuranceOptions,
            lastPrompt: response.text,
          },
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      if (selectedStep === 'PROCEDURE') {
        if (normalizeText(context.selectedInsurance || '') === 'particular') {
          const response = { text: 'Certo. Qual procedimento você deseja consultar no particular?' };
          await saveConversation(conversation.id, {
            state: 'AWAITING_PRIVATE_PROCEDURE_INPUT',
            context: {
              ...context,
              selectedProcedureId: null,
              selectedProcedureName: null,
              selectedProcedurePrice: null,
              selectedDoctorId: null,
              selectedDoctorName: null,
              suggestedDate: null,
              suggestedTime: null,
              suggestedDurationMinutes: null,
              preferredDate: null,
              privateProcedureSearchText: null,
              privateProcedureMatchId: null,
              privateProcedureMatchName: null,
              privateProcedureMatchPrice: null,
              lastPrompt: response.text,
            },
            lastInboundMessage: text,
            lastOutboundMessage: response.text,
          });
          return { handled: true, response };
        }

        const procedureOptions = await listProcedureOptions(
          getTargetBranchId(),
          context.serviceType || 'CONSULTA',
          context.selectedInsurance || patient?.healthInsuranceName || '',
        );
        const response: ChatbotResponse = {
          text: 'Qual procedimento você deseja?',
          listOptions: toListOptions(procedureOptions, 'Ver procedimentos', 'Procedimentos disponíveis'),
        };
        await saveConversation(conversation.id, {
          state: 'AWAITING_PROCEDURE',
          context: {
            ...context,
            selectedProcedureId: null,
            selectedProcedureName: null,
            selectedDoctorId: null,
            selectedDoctorName: null,
            suggestedDate: null,
            suggestedTime: null,
            suggestedDurationMinutes: null,
            preferredDate: null,
            options: procedureOptions,
            lastPrompt: response.text,
          },
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      if (selectedStep === 'SLOT') {
        const response = { text: 'Certo. Qual é a sua preferência de dia? Você pode responder, por exemplo, com 15/04/2026, hoje, amanhã ou segunda.' };
        await saveConversation(conversation.id, {
          state: 'AWAITING_PREFERRED_DATE',
          context: {
            ...context,
            selectedDoctorId: null,
            selectedDoctorName: null,
            suggestedDate: null,
            suggestedTime: null,
            suggestedDurationMinutes: null,
            preferredDate: null,
            lastPrompt: response.text,
          },
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      if (selectedStep === 'CPF') {
        const response = { text: 'Tudo bem. Informe seu CPF novamente.' };
        await saveConversation(conversation.id, {
          state: 'AWAITING_CPF',
          patientId: null,
          patientName: isNewPatient ? null : conversation.patientName,
          context: {
            ...context,
            cpfCandidate: null,
            nameCandidate: isNewPatient ? null : context.nameCandidate,
            birthDateCandidate: isNewPatient ? null : context.birthDateCandidate,
            lastPrompt: response.text,
          },
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      if (selectedStep === 'NAME') {
        const response = { text: 'Perfeito. Agora informe seu nome completo.' };
        await saveConversation(conversation.id, {
          state: 'AWAITING_NEW_PATIENT_NAME',
          patientName: null,
          context: {
            ...context,
            nameCandidate: null,
            birthDateCandidate: null,
            lastPrompt: response.text,
          },
          lastInboundMessage: text,
          lastOutboundMessage: response.text,
        });
        return { handled: true, response };
      }

      const response = { text: 'Informe sua data de nascimento no formato DD/MM/AAAA.' };
      await saveConversation(conversation.id, {
        state: 'AWAITING_NEW_PATIENT_BIRTHDATE',
        context: {
          ...context,
          birthDateCandidate: null,
          lastPrompt: response.text,
        },
        lastInboundMessage: text,
        lastOutboundMessage: response.text,
      });
      return { handled: true, response };
    }

    default: {
      const response = buildMenuMessage(patient?.name || conversation.patientName || null);
      await saveConversation(conversation.id, {
        state: 'AWAITING_SERVICE',
        selectedService: null,
        context: {},
        lastInboundMessage: text,
        lastOutboundMessage: response.text,
      });
      return { handled: true, response };
    }
  }
}

export async function handleWhatsAppChatbot(input: ChatbotInput): Promise<ChatbotResult> {
  const text = String(input.text || '').trim();
  const phone = formatPhoneForLookup(input.phone);
  if (!text || !phone) return { handled: false };

  const branchConfig = await resolveBranchConfig(input.branchIdHint);
  if (!branchConfig?.branchId) return { handled: false };

  // v3 + Flow mode: send a WhatsApp Flow when user sends initial message in a fresh conversation
  if (branchConfig.flowId) {
    const isFlowComplete = text.startsWith('[FLOW_COMPLETE]');
    if (!isFlowComplete) {
      const existingConversation = await prisma.whatsAppConversation.findUnique({
        where: { branchId_phone: { branchId: branchConfig.branchId, phone } },
        select: { state: true, humanStatus: true },
      });

      const isNewOrMenu = !existingConversation || existingConversation.state === 'MENU';
      const isHumanActive = existingConversation?.humanStatus === 'QUEUED'
        || existingConversation?.humanStatus === 'ASSIGNED';

      if (isNewOrMenu && !isHumanActive) {
        const convRecord = await upsertConversation({ branchId: branchConfig.branchId, phone, patient: await lookupPatient(branchConfig.branchId, phone) });
        const flowToken = Buffer.from(JSON.stringify({ branchId: branchConfig.branchId, phone, conversationId: convRecord.id })).toString('base64');
        const messaging = new MetaMessagingService({
          bearerToken: branchConfig.apiKey,
          appId: branchConfig.appId || branchConfig.appName,
          sourceNumber: branchConfig.sourceNumber,
        });

        try {
          await messaging.sendFlowMessage({
            to: phone,
            flowId: branchConfig.flowId,
            flowToken,
            bodyText: 'Olá! Para agendar uma consulta ou exame, preencha o formulário abaixo.',
            ctaText: 'Agendar',
          });
        } catch (flowErr: any) {
          console.error('[chatbot] sendFlowMessage failed, falling back to text menu', flowErr?.message);
        }

        return { handled: true };
      }
    }
  }

  let patient = await lookupPatient(branchConfig.branchId, phone);
  let conversation = await upsertConversation({
    branchId: branchConfig.branchId,
    phone,
    patient,
  });

  const conversationContext = parseJsonContext(conversation.context);
  if (conversationContext.selectedBranchId) {
    patient = await lookupPatient(conversationContext.selectedBranchId, phone);
  }

  await recordConversationMessage({
    conversationId: conversation.id,
    branchId: conversationContext.selectedBranchId || branchConfig.branchId,
    phone,
    flowKey: conversation.humanFlowKey || null,
    protocolNumber: conversation.humanProtocolNumber || undefined,
    authorType: 'PATIENT',
    authorName: patient?.name || conversation.patientName || 'Paciente',
    message: text,
    metadata: input.metadata || undefined,
  });

  if (conversation.humanStatus === 'QUEUED' && shouldResetConversation(text)) {
    await saveConversation(conversation.id, {
      state: 'MENU',
      selectedService: null,
      context: {},
      lastInboundMessage: text,
      patientId: patient?.id || conversation.patientId || null,
      patientName: patient?.name || conversation.patientName || null,
      handoffTicketId: null,
      reservedAppointmentId: null,
      humanStatus: null,
      humanFlowKey: null,
      humanFlowLabel: null,
      humanAssignedUserId: null,
      humanAssignedUserName: null,
      humanAssignedAt: null,
      humanClosedAt: null,
      humanClosedByUserId: null,
      humanClosedByUserName: null,
      humanProtocolNumber: null,
      humanProtocolStartedAt: null,
      humanProtocolClosedAt: null,
      humanIdleWarningSentAt: null,
      humanLastOperatorMessageAt: null,
      humanLastPatientMessageAt: new Date(),
    });

    conversation = {
      ...conversation,
      state: 'MENU',
      selectedService: null,
      context: {},
      handoffTicketId: null,
      reservedAppointmentId: null,
      humanStatus: null,
      humanFlowKey: null,
      humanFlowLabel: null,
      humanAssignedUserId: null,
      humanAssignedUserName: null,
      humanAssignedAt: null,
      humanClosedAt: null,
      humanClosedByUserId: null,
      humanClosedByUserName: null,
      humanProtocolNumber: null,
      humanProtocolStartedAt: null,
      humanProtocolClosedAt: null,
      humanIdleWarningSentAt: null,
      humanLastOperatorMessageAt: null,
      humanLastPatientMessageAt: new Date(),
      lastInboundMessage: text,
    };
  } else if (conversation.humanStatus === 'QUEUED' || conversation.humanStatus === 'ASSIGNED') {
    await saveConversation(conversation.id, {
      lastInboundMessage: text,
      patientId: patient?.id || conversation.patientId || null,
      patientName: patient?.name || conversation.patientName || null,
      humanLastPatientMessageAt: new Date(),
      humanIdleWarningSentAt: null,
    });
    return { handled: true };
  }

  const result = await processFlow({
    branchConfig,
    conversation,
    patient,
    input: {
      phone,
      text,
    },
  });

  if (result.handled && result.response) {
    await sendResponse(branchConfig, phone, result.response);
    await recordConversationMessage({
      conversationId: conversation.id,
      branchId: conversationContext.selectedBranchId || branchConfig.branchId,
      phone,
      flowKey: conversation.humanFlowKey || null,
      authorType: 'BOT',
      authorName: 'Saudy Bot',
      message: result.response.text,
    });
  }

  return result;
}

export default handleWhatsAppChatbot;
