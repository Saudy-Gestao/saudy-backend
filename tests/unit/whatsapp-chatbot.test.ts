import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HUMAN_FLOWS, handleWhatsAppChatbot } from '../../src/modules/care/lib/whatsapp-chatbot';
import prisma from '../../src/modules/care/lib/prisma';

const sendTextMessageMock = vi.fn();
const sendQuickReplyMessageMock = vi.fn();
const sendListMessageMock = vi.fn();

const sendFlowMessageMock = vi.fn();

vi.mock('../../src/modules/care/lib/gupshup', () => ({
  default: vi.fn().mockImplementation(() => ({
    sendTextMessage: sendTextMessageMock,
    sendQuickReplyMessage: sendQuickReplyMessageMock,
    sendListMessage: sendListMessageMock,
  })),
  GupshupV3Service: vi.fn().mockImplementation(() => ({
    sendTextMessage: sendTextMessageMock,
    sendQuickReplyMessage: sendQuickReplyMessageMock,
    sendListMessage: sendListMessageMock,
    sendFlowMessage: sendFlowMessageMock,
  })),
}));

vi.mock('../../src/modules/care/lib/appointment-whatsapp-events', () => ({
  publishAppointmentCreatedEvent: vi.fn(),
}));

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    branch: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    whatsAppConfig: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    patient: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    whatsAppConversation: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    whatsAppConversationMessage: {
      create: vi.fn(),
    },
    whatsAppConversationMedia: {
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    appointment: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    procedure: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    insurance: {
      findMany: vi.fn(),
    },
    procedureDoctor: {
      findMany: vi.fn(),
    },
    doctor: {
      findMany: vi.fn(),
    },
    whatsAppTicket: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

const mockedPrisma = prisma as any;

const makeConversation = (overrides: Record<string, unknown> = {}) => ({
  id: 'conv-1',
  branchId: 'b-1',
  phone: '11999998888',
  patientId: null,
  patientName: null,
  state: 'MENU',
  context: {},
  humanStatus: null,
  selectedService: null,
  lastInteractionAt: new Date(),
  ...overrides,
});

describe('handleWhatsAppChatbot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.branch.findUnique.mockResolvedValue({ id: 'b-1', tradeName: 'Saudy', companyId: 'c-1' });
    mockedPrisma.branch.findMany.mockResolvedValue([{ id: 'b-1', tradeName: 'Saudy' }]);
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValue({
      branchId: 'b-1',
      isActive: true,
      accountSid: 'api-key',
      authToken: 'app-name',
      fromNumber: '5511999990000',
    });
    mockedPrisma.whatsAppConfig.findMany.mockResolvedValue([]);
    mockedPrisma.patient.findMany.mockResolvedValue([]);
    mockedPrisma.patient.findFirst.mockResolvedValue(null);
    mockedPrisma.patient.update.mockResolvedValue({ id: 'p-1' });
    mockedPrisma.patient.create.mockResolvedValue({ id: 'p-1', name: 'Paciente', cpf: '12345678901', healthInsuranceName: null });
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      branchId: 'b-1',
      phone: '11999998888',
      patientId: null,
      patientName: null,
      state: 'MENU',
      context: {},
      humanStatus: null,
      selectedService: null,
      lastInteractionAt: new Date(),
    });
    mockedPrisma.whatsAppConversation.create.mockResolvedValue({
      id: 'conv-1',
      branchId: 'b-1',
      phone: '11999998888',
      patientId: null,
      patientName: null,
      state: 'MENU',
      context: {},
      humanStatus: null,
      selectedService: null,
      lastInteractionAt: new Date(),
    });
    mockedPrisma.whatsAppConversation.update.mockImplementation(async (params: any) => ({
      id: 'conv-1',
      branchId: 'b-1',
      phone: '11999998888',
      patientId: params?.data?.patientId ?? null,
      patientName: params?.data?.patientName ?? null,
      state: params?.data?.state ?? 'MENU',
      context: params?.data?.context ?? {},
      humanStatus: params?.data?.humanStatus ?? null,
      selectedService: params?.data?.selectedService ?? null,
      lastInteractionAt: new Date(),
    }));
    mockedPrisma.whatsAppConversationMessage.create.mockResolvedValue({ id: 'msg-1' });
    mockedPrisma.whatsAppConversationMedia.create.mockResolvedValue({ id: 'media-1' });
    mockedPrisma.whatsAppConversationMedia.updateMany.mockResolvedValue({ count: 0 });
    mockedPrisma.appointment.findMany.mockResolvedValue([]);
    mockedPrisma.appointment.findFirst.mockResolvedValue(null);
    mockedPrisma.appointment.create.mockResolvedValue({ id: 'a-1' });
    mockedPrisma.procedure.findMany.mockResolvedValue([]);
    mockedPrisma.procedure.findFirst.mockResolvedValue(null);
    mockedPrisma.insurance.findMany.mockResolvedValue([]);
    mockedPrisma.procedureDoctor.findMany.mockResolvedValue([]);
    mockedPrisma.doctor.findMany.mockResolvedValue([]);
    mockedPrisma.whatsAppTicket.create.mockResolvedValue({ id: 't-1' });
    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb({
      appointment: {
        create: vi.fn().mockResolvedValue({ id: 'a-1' }),
      },
      preSchedulingFlow: {
        create: vi.fn().mockResolvedValue({ id: 'f-1' }),
      },
    }));
    sendTextMessageMock.mockResolvedValue({ status: 'success', messageId: 'm-1' });
    sendQuickReplyMessageMock.mockResolvedValue({ status: 'success', messageId: 'm-2' });
    sendListMessageMock.mockResolvedValue({ status: 'success', messageId: 'm-3' });
    sendFlowMessageMock.mockResolvedValue({ status: 'success', messageId: 'm-4' });
  });

  it('returns handled false when text is empty', async () => {
    const result = await handleWhatsAppChatbot({ phone: '11999998888', text: '' });
    expect(result).toEqual({ handled: false });
  });

  it('returns handled false when phone is invalid', async () => {
    const result = await handleWhatsAppChatbot({ phone: '', text: 'oi' });
    expect(result).toEqual({ handled: false });
  });

  it('returns handled false when no active branch config is resolvable', async () => {
    mockedPrisma.whatsAppConfig.findMany.mockResolvedValue([]);

    const result = await handleWhatsAppChatbot({
      phone: '11999998888',
      text: 'oi',
    });

    expect(result).toEqual({ handled: false });
    expect(mockedPrisma.whatsAppConfig.findMany).toHaveBeenCalled();
  });

  it('returns handled false when multiple active branch configs exist without hint', async () => {
    mockedPrisma.whatsAppConfig.findMany.mockResolvedValueOnce([
      { branchId: 'b-1', isActive: true, accountSid: 'k1', authToken: 'a1', fromNumber: '551100000001' },
      { branchId: 'b-2', isActive: true, accountSid: 'k2', authToken: 'a2', fromNumber: '551100000002' },
    ]);

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'oi',
    });

    expect(result).toEqual({ handled: false });
    expect(mockedPrisma.whatsAppConfig.findMany).toHaveBeenCalled();
  });

  it('exports expected human flow definitions', () => {
    const keys = HUMAN_FLOWS.map((flow) => flow.key);
    expect(keys).toContain('DUVIDAS');
    expect(keys).toContain('CONFIRMACAO_REAGENDAMENTO');
  });

  it('handles menu state and sends menu response', async () => {
    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'oi',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(sendListMessageMock).toHaveBeenCalled();
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalled();
  });

  it('re-looks up patient using selected branch from conversation context', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_SERVICE',
      context: { selectedBranchId: 'b-2' },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'oi',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(mockedPrisma.patient.findMany).toHaveBeenCalledTimes(2);
    expect(mockedPrisma.patient.findMany.mock.calls[1][0]).toEqual(expect.objectContaining({
      where: expect.objectContaining({ branchId: 'b-2' }),
    }));
  });

  it('handles assigned human conversation without bot response', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce({
      id: 'conv-1',
      branchId: 'b-1',
      phone: '11999998888',
      state: 'AWAITING_SERVICE',
      context: {},
      humanStatus: 'ASSIGNED',
      patientId: null,
      patientName: null,
    });

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'qualquer texto',
      branchIdHint: 'b-1',
    });

    expect(result).toEqual({ handled: true });
    expect(sendTextMessageMock).not.toHaveBeenCalled();
  });

  it('handles awaiting service branch for next appointments without identified patient', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce({
      id: 'conv-1',
      branchId: 'b-1',
      phone: '11999998888',
      state: 'AWAITING_SERVICE',
      context: {},
      humanStatus: null,
      patientId: null,
      patientName: null,
      selectedService: null,
    });

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '4',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Não consegui identificar seu cadastro');
    expect(sendTextMessageMock).toHaveBeenCalled();
  });

  it('moves from awaiting service to unit selection for consult flow', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_SERVICE',
      context: {},
      humanStatus: null,
      selectedService: null,
    }));
    mockedPrisma.branch.findMany.mockResolvedValueOnce([
      { id: 'b-1', tradeName: 'Saudy' },
      { id: 'b-2', tradeName: 'Saudy Centro' },
    ]);

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '1',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Qual unidade você deseja?');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_UNIT',
        selectedService: 'CONSULTA',
      }),
    }));
  });

  it('resets queued human conversation when user sends greeting', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce({
      id: 'conv-1',
      branchId: 'b-1',
      phone: '11999998888',
      state: 'AWAITING_SERVICE',
      context: { selectedBranchId: 'b-1' },
      humanStatus: 'QUEUED',
      patientId: null,
      patientName: null,
      selectedService: null,
    });

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'oi',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(sendListMessageMock).toHaveBeenCalled();
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: 'conv-1' },
      data: expect.objectContaining({
        humanStatus: null,
        state: 'MENU',
      }),
    }));
  });

  it('keeps queued/assigned conversation handled without bot response for regular messages', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce({
      id: 'conv-1',
      branchId: 'b-1',
      phone: '11999998888',
      state: 'AWAITING_SERVICE',
      context: {},
      humanStatus: 'QUEUED',
      patientId: null,
      patientName: null,
      selectedService: null,
    });

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'preciso falar com atendente',
      branchIdHint: 'b-1',
    });

    expect(result).toEqual({ handled: true });
    expect(sendTextMessageMock).not.toHaveBeenCalled();
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        humanLastPatientMessageAt: expect.any(Date),
      }),
    }));
  });

  it('repeats service menu when service selection is invalid', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_SERVICE',
      patientName: 'Maria',
      context: {},
      humanStatus: null,
      selectedService: null,
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'servico invalido',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Como posso te ajudar');
    expect(result.response?.listOptions?.options.length).toBeGreaterThan(0);
  });

  it('goes back to previous prompt when user sends VOLTAR', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce({
      id: 'conv-1',
      branchId: 'b-1',
      phone: '11999998888',
      state: 'AWAITING_CPF',
      context: {
        history: [
          {
            state: 'AWAITING_FINAL_CONFIRMATION',
            prompt: 'Confirma os dados abaixo?\n1. Sim\n2. Não',
            context: { selectedInsurance: 'Particular' },
          },
        ],
      },
      humanStatus: null,
      patientId: null,
      patientName: null,
      selectedService: 'CONSULTA',
    });

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'VOLTAR',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Confirma os dados abaixo?');
    expect(result.response?.binaryOptions).toBe(true);
    expect(sendQuickReplyMessageMock).toHaveBeenCalled();
  });

  it('routes procedure-not-found action to private flow', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PROCEDURE_NOT_FOUND_ACTION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        selectedInsurance: 'Unimed',
        lastPrompt: 'Tudo bem. O que você deseja fazer agora?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '2',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('consultar no particular');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_PRIVATE_PROCEDURE_INPUT',
      }),
    }));
  });

  it('opens human handoff when procedure-not-found action requests attendant', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PROCEDURE_NOT_FOUND_ACTION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        selectedInsurance: 'Unimed',
        lastPrompt: 'Tudo bem. O que você deseja fazer agora?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '1',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('encaminhar você para um dos nossos atendentes');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'HANDED_OFF',
      }),
    }));
  });

  it('repeats procedure-not-found action prompt when option is invalid', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PROCEDURE_NOT_FOUND_ACTION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        selectedInsurance: 'Unimed',
        lastPrompt: '1. Falar com atendente\n2. Desejo consultar no particular',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'opcao invalida',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Falar com atendente');
  });

  it('asks for more detail when private procedure text is too short', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PRIVATE_PROCEDURE_INPUT',
      context: { selectedBranchId: 'b-1', lastPrompt: 'Qual procedimento?' },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'rx',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('um pouco mais de detalhe');
  });

  it('moves private procedure input to confirmation using fallback prompt history', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PRIVATE_PROCEDURE_INPUT',
      context: { selectedBranchId: 'b-1' },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'Ultrassom de abdomen',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Você quis dizer o procedimento');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_PRIVATE_PROCEDURE_CONFIRMATION',
      }),
    }));
  });

  it('repeats private procedure confirmation prompt when answer is not yes/no', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PRIVATE_PROCEDURE_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        privateProcedureSearchText: 'Ultrassom',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'talvez',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Confirma o procedimento informado?');
  });

  it('asks to retype private procedure when confirmation is denied', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PRIVATE_PROCEDURE_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        privateProcedureSearchText: 'Ultrassom',
        privateProcedureSearchAttempts: 0,
        lastPrompt: 'Confirma o procedimento informado?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '2',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Digite novamente');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_PRIVATE_PROCEDURE_INPUT',
      }),
    }));
  });

  it('opens handoff after repeated unmatched private procedure search', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PRIVATE_PROCEDURE_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        privateProcedureSearchText: 'Procedimento inexistente',
        privateProcedureSearchAttempts: 1,
        lastPrompt: 'Confirma o procedimento informado?',
      },
    }));
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([]);

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'sim',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('encaminhar você para um dos nossos atendentes');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'HANDED_OFF',
      }),
    }));
  });

  it('asks for a second private procedure search attempt when first match fails', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PRIVATE_PROCEDURE_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        privateProcedureSearchText: 'Procedimento raro',
        privateProcedureSearchAttempts: 0,
        lastPrompt: 'Confirma o procedimento informado?',
      },
    }));
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([]);

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'sim',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Tente descrever novamente');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_PRIVATE_PROCEDURE_INPUT',
      }),
    }));
  });

  it('moves to private procedure match confirmation when a match is found', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PRIVATE_PROCEDURE_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        privateProcedureSearchText: 'ultrassom',
        privateProcedureSearchAttempts: 0,
        lastPrompt: 'Confirma o procedimento informado?',
      },
    }));
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([
      {
        id: 'proc-1',
        name: 'Ultrassom de Abdomen',
        price: 200,
        durationMinutes: 30,
      },
    ]);

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'sim',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Encontrei este procedimento no particular');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_PRIVATE_PROCEDURE_MATCH_CONFIRMATION',
      }),
    }));
  });

  it('repeats private procedure match confirmation prompt when answer is not yes/no', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PRIVATE_PROCEDURE_MATCH_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        privateProcedureMatchId: 'proc-1',
        privateProcedureMatchName: 'Ultrassom',
        privateProcedureMatchPrice: 120,
        privateProcedureSearchAttempts: 1,
        lastPrompt: 'Deseja seguir com o procedimento particular encontrado?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'talvez',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Deseja seguir com o procedimento particular encontrado?');
  });

  it('opens handoff when private procedure match is denied after retries', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PRIVATE_PROCEDURE_MATCH_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        privateProcedureSearchAttempts: 2,
        privateProcedureMatchId: 'proc-1',
        lastPrompt: 'Deseja seguir com o procedimento particular encontrado?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'não',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('encaminhar você para um dos nossos atendentes');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'HANDED_OFF',
      }),
    }));
  });

  it('returns to private procedure input when match is denied before retry limit', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PRIVATE_PROCEDURE_MATCH_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        privateProcedureSearchAttempts: 1,
        privateProcedureMatchId: 'proc-1',
        privateProcedureMatchName: 'Ultrassom',
        privateProcedureMatchPrice: 120,
        lastPrompt: 'Deseja seguir com o procedimento particular encontrado?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'não',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Digite novamente qual procedimento');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_PRIVATE_PROCEDURE_INPUT',
      }),
    }));
  });

  it('opens handoff when private procedure match is accepted but no slot is found', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PRIVATE_PROCEDURE_MATCH_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        privateProcedureSearchAttempts: 1,
        privateProcedureMatchId: 'proc-1',
        privateProcedureMatchName: 'Ultrassom',
        privateProcedureMatchPrice: 200,
        lastPrompt: 'Deseja seguir com o procedimento particular encontrado?',
      },
    }));
    mockedPrisma.procedure.findFirst.mockResolvedValueOnce({
      id: 'proc-1',
      name: 'Ultrassom',
      durationMinutes: 30,
      price: 200,
    });
    mockedPrisma.procedureDoctor.findMany.mockResolvedValueOnce([{ doctorId: 'doc-1' }]);
    mockedPrisma.doctor.findMany.mockResolvedValueOnce([
      {
        id: 'doc-1',
        name: 'Dr. Teste',
        isActive: true,
        workingDays: ['SEGUNDA', 'TERCA', 'QUARTA', 'QUINTA', 'SEXTA', 'SABADO', 'DOMINGO'],
        workingHoursStart: '08:00',
        workingHoursEnd: '18:00',
      },
    ]);
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([]);

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'sim',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('encaminhar você para um dos nossos atendentes');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'HANDED_OFF',
      }),
    }));
  });

  it('opens handoff when matched private procedure id is no longer resolvable', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PRIVATE_PROCEDURE_MATCH_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        privateProcedureSearchAttempts: 1,
        privateProcedureMatchId: 'proc-missing',
        lastPrompt: 'Deseja seguir com o procedimento particular encontrado?',
      },
    }));
    mockedPrisma.procedure.findFirst.mockResolvedValueOnce(null);

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'sim',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('encaminhar você para um dos nossos atendentes');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'HANDED_OFF',
      }),
    }));
  });

  it('opens handoff when private procedure match is accepted without a matched id', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PRIVATE_PROCEDURE_MATCH_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        privateProcedureSearchAttempts: 1,
        privateProcedureMatchId: null,
        privateProcedureMatchName: 'Ultrassom',
        privateProcedureMatchPrice: 200,
        lastPrompt: 'Deseja seguir com o procedimento particular encontrado?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'sim',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('encaminhar você para um dos nossos atendentes');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'HANDED_OFF',
      }),
    }));
  });

  it('moves to slot confirmation when private procedure match is accepted and slot exists', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PRIVATE_PROCEDURE_MATCH_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        privateProcedureSearchAttempts: 1,
        privateProcedureMatchId: 'proc-1',
        privateProcedureMatchName: 'Ultrassom',
        privateProcedureMatchPrice: 200,
        lastPrompt: 'Deseja seguir com o procedimento particular encontrado?',
      },
    }));
    mockedPrisma.procedure.findFirst
      .mockResolvedValueOnce({
        id: 'proc-1',
        name: 'Ultrassom',
        durationMinutes: 30,
        price: 200,
      })
      .mockResolvedValueOnce({
        id: 'proc-1',
        name: 'Ultrassom',
        durationMinutes: 30,
        price: 200,
      });
    mockedPrisma.procedureDoctor.findMany.mockResolvedValueOnce([{ doctorId: 'doc-1' }]);
    mockedPrisma.doctor.findMany.mockResolvedValueOnce([
      {
        id: 'doc-1',
        name: 'Dr. Teste',
        isActive: true,
        workingDays: ['SEGUNDA', 'TERCA', 'QUARTA', 'QUINTA', 'SEXTA', 'SABADO', 'DOMINGO'],
        workingHoursStart: '08:00',
        workingHoursEnd: '18:00',
      },
    ]);
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([
      {
        id: 'appt-busy',
        doctorId: 'doc-1',
        date: '2099-01-01',
        time: '10:00',
        durationMinutes: 30,
      },
    ]);

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'sim',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Deseja seguir com esse horário?');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_SLOT_CONFIRMATION',
        context: expect.objectContaining({
          selectedInsurance: 'Particular',
          selectedProcedureId: 'proc-1',
          selectedProcedureName: 'Ultrassom',
        }),
      }),
    }));
  });

  it('validates CPF and asks confirmation on valid input', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_CPF',
      context: { selectedBranchId: 'b-1', lastPrompt: 'Para continuar, informe seu CPF.' },
    }));

    const invalid = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '123',
      branchIdHint: 'b-1',
    });

    expect(invalid.handled).toBe(true);
    expect(invalid.response?.text).toContain('CPF informado parece inválido');

    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_CPF',
      context: { selectedBranchId: 'b-1', lastPrompt: 'Para continuar, informe seu CPF.' },
    }));

    const valid = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '529.982.247-25',
      branchIdHint: 'b-1',
    });

    expect(valid.handled).toBe(true);
    expect(valid.response?.text).toContain('Confirma que o CPF');
    expect(valid.response?.binaryOptions).toBe(true);
    expect(sendQuickReplyMessageMock).toHaveBeenCalled();
  });

  it('returns to cpf state when cpf confirmation is denied', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_CPF_CONFIRMATION',
      context: {
        selectedBranchId: 'b-1',
        cpfCandidate: '52998224725',
        lastPrompt: 'Confirma o CPF informado?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'não',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Informe seu CPF novamente');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_CPF',
      }),
    }));
  });

  it('opens edit selection when final confirmation is denied', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_FINAL_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        selectedInsurance: 'Unimed',
        selectedProcedureName: 'Consulta clínica',
        selectedDoctorName: 'Dr. Teste',
        suggestedDate: '2026-04-20',
        suggestedTime: '09:00',
        lastPrompt: 'Confirma os dados abaixo?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '2',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Qual etapa você deseja alterar');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_CONFIRMATION_EDIT_SELECTION',
      }),
    }));
  });

  it('edits service and private procedure branches from confirmation-edit state', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_CONFIRMATION_EDIT_SELECTION',
      context: {
        serviceType: 'CONSULTA',
        selectedInsurance: 'Unimed',
        lastPrompt: 'Qual etapa você deseja alterar?',
      },
      patientName: 'Paciente Teste',
    }));

    const toService = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '1',
      branchIdHint: 'b-1',
    });

    expect(toService.handled).toBe(true);
    expect(toService.response?.text).toContain('Como posso te ajudar hoje?');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_SERVICE',
      }),
    }));

    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_CONFIRMATION_EDIT_SELECTION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedInsurance: 'Particular',
        selectedProcedureName: 'Ultrassom',
        lastPrompt: 'Qual etapa você deseja alterar?',
      },
    }));

    const toPrivateProcedure = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '3',
      branchIdHint: 'b-1',
    });

    expect(toPrivateProcedure.handled).toBe(true);
    expect(toPrivateProcedure.response?.text).toContain('consultar no particular');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_PRIVATE_PROCEDURE_INPUT',
      }),
    }));
  });

  it('repeats final summary prompt when final confirmation answer is not yes/no', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_FINAL_CONFIRMATION',
      context: {
        selectedBranchName: 'Saudy',
        selectedInsurance: 'Unimed',
        selectedProcedureName: 'Consulta clínica',
        selectedDoctorName: 'Dr. Teste',
        suggestedDate: '2026-04-20',
        suggestedTime: '09:00',
        serviceType: 'CONSULTA',
        lastPrompt: 'Confirma os dados abaixo?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'talvez',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Confirma os dados abaixo?');
    expect(result.response?.binaryOptions).toBe(true);
    expect(sendQuickReplyMessageMock).toHaveBeenCalled();
  });

  it('re-prompts edit selection when choosing a disallowed step for existing patient', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_CONFIRMATION_EDIT_SELECTION',
      patientId: 'p-1',
      patientName: 'Paciente Antigo',
      context: {
        serviceType: 'CONSULTA',
        selectedInsurance: 'Unimed',
        selectedProcedureName: 'Consulta clínica',
        lastPrompt: 'Qual etapa você deseja alterar?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '6',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Qual etapa você deseja alterar');
  });

  it('routes edit selection to unit and insurance steps', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_CONFIRMATION_EDIT_SELECTION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedInsurance: 'Unimed',
        lastPrompt: 'Qual etapa você deseja alterar?',
      },
    }));

    const unitResult = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '0',
      branchIdHint: 'b-1',
    });

    expect(unitResult.handled).toBe(true);
    expect(unitResult.response?.text).toContain('Qual unidade você deseja?');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_UNIT',
      }),
    }));

    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_CONFIRMATION_EDIT_SELECTION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedInsurance: 'Unimed',
        selectedProcedureName: 'Consulta clínica',
        lastPrompt: 'Qual etapa você deseja alterar?',
      },
    }));

    const insuranceResult = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '2',
      branchIdHint: 'b-1',
    });

    expect(insuranceResult.handled).toBe(true);
    expect(insuranceResult.response?.text).toContain('Qual é o seu convênio?');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_INSURANCE',
      }),
    }));
  });

  it('routes edit selection to procedure list for non-particular insurance', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_CONFIRMATION_EDIT_SELECTION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedInsurance: 'Unimed',
        selectedProcedureName: 'Consulta clínica',
        lastPrompt: 'Qual etapa você deseja alterar?',
      },
    }));
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([
      { id: 'proc-1', name: 'Consulta clínica', acceptsInsurance: true, acceptedInsurances: ['Unimed'] },
    ]);

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '3',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Qual procedimento você deseja?');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_PROCEDURE',
      }),
    }));
  });

  it('routes edit selection to slot, cpf, name and birthdate steps', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_CONFIRMATION_EDIT_SELECTION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedInsurance: 'Unimed',
        selectedProcedureName: 'Consulta clínica',
        lastPrompt: 'Qual etapa você deseja alterar?',
      },
    }));

    const slotResult = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '4',
      branchIdHint: 'b-1',
    });
    expect(slotResult.handled).toBe(true);
    expect(slotResult.response?.text).toContain('preferência de dia');

    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_CONFIRMATION_EDIT_SELECTION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedInsurance: 'Unimed',
        selectedProcedureName: 'Consulta clínica',
        lastPrompt: 'Qual etapa você deseja alterar?',
      },
    }));

    const cpfResult = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '5',
      branchIdHint: 'b-1',
    });
    expect(cpfResult.handled).toBe(true);
    expect(cpfResult.response?.text).toContain('Informe seu CPF novamente');

    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_CONFIRMATION_EDIT_SELECTION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedInsurance: 'Unimed',
        selectedProcedureName: 'Consulta clínica',
        lastPrompt: 'Qual etapa você deseja alterar?',
      },
    }));

    const nameResult = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '6',
      branchIdHint: 'b-1',
    });
    expect(nameResult.handled).toBe(true);
    expect(nameResult.response?.text).toContain('informe seu nome completo');

    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_CONFIRMATION_EDIT_SELECTION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedInsurance: 'Unimed',
        selectedProcedureName: 'Consulta clínica',
        lastPrompt: 'Qual etapa você deseja alterar?',
      },
    }));

    const birthdateResult = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '7',
      branchIdHint: 'b-1',
    });
    expect(birthdateResult.handled).toBe(true);
    expect(birthdateResult.response?.text).toContain('data de nascimento');
  });

  it('routes cpf edit for existing patient preserving candidate values', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_CONFIRMATION_EDIT_SELECTION',
      patientId: 'p-1',
      patientName: 'Paciente Antigo',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedInsurance: 'Unimed',
        nameCandidate: 'Nome Prévio',
        birthDateCandidate: '1990-01-01',
        lastPrompt: 'Qual etapa você deseja alterar?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '5',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Informe seu CPF novamente');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_CPF',
        patientName: 'Paciente Antigo',
      }),
    }));
  });

  it('falls back to menu when conversation state is unknown', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'UNKNOWN_STATE',
      context: {},
      patientName: 'Paciente X',
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'qualquer',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Como posso te ajudar hoje?');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_SERVICE',
      }),
    }));
  });

  it('handles doubts option from service menu and opens human handoff', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_SERVICE',
      context: {},
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'duvidas',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('protocolo');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'HANDED_OFF',
        selectedService: 'DUVIDAS',
      }),
    }));
  });

  it('returns personalized no-appointments message when patient is identified', async () => {
    mockedPrisma.appointment.findMany.mockReset();
    mockedPrisma.appointment.findMany.mockResolvedValue([]);
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_SERVICE',
      context: {},
      patientId: 'p-1',
      patientName: 'Maria',
    }));
    mockedPrisma.patient.findMany
      .mockResolvedValueOnce([
        {
          id: 'p-1',
          name: 'Maria',
          cpf: '52998224725',
          healthInsuranceName: 'Unimed',
          updatedAt: new Date(),
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'p-1',
          name: 'Maria',
          cpf: '52998224725',
          healthInsuranceName: 'Unimed',
          updatedAt: new Date(),
        },
      ]);

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '4',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('no momento para você, Maria');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_SERVICE',
      }),
    }));
  });

  it('returns next appointment details when patient has an upcoming schedule', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockReset();
    mockedPrisma.patient.findMany.mockReset();
    mockedPrisma.appointment.findMany.mockReset();
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_SERVICE',
      context: {},
      patientId: 'p-1',
      patientName: 'Maria',
    }));
    mockedPrisma.patient.findMany.mockResolvedValue([
      {
        id: 'p-1',
        name: 'Maria',
        cpf: '52998224725',
        healthInsuranceName: 'Unimed',
        updatedAt: new Date(),
      },
    ]);
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([
      {
        id: 'a-1',
        branchId: 'b-1',
        date: '2099-12-31',
        time: '10:30:00',
        type: 'CONSULTA',
        status: 'CONFIRMADO',
        doctorName: 'Dr. House',
        specialty: 'Consulta clínica',
        convenio: 'Unimed',
      },
    ]);

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '4',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Encontrei seu próximo agendamento, Maria:');
    expect(result.response?.text).toContain('Unidade: Saudy');
    expect(result.response?.text).toContain('Profissional: Dr. House');
  });

  it('returns generic no-appointments message when identified patient has no name', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockReset();
    mockedPrisma.patient.findMany.mockReset();
    mockedPrisma.appointment.findMany.mockReset();
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_SERVICE',
      context: {},
      patientId: 'p-2',
      patientName: null,
    }));
    mockedPrisma.patient.findMany.mockResolvedValue([
      {
        id: 'p-2',
        name: null,
        cpf: '52998224725',
        healthInsuranceName: null,
        updatedAt: new Date(),
      },
    ]);
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([]);

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '4',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Não encontrei próximas consultas ou exames agendados no momento para você.');
  });

  it('repeats unit prompt when selected unit option is invalid', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockReset();
    mockedPrisma.patient.findMany.mockReset();
    mockedPrisma.patient.findMany.mockResolvedValue([]);
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_UNIT',
      selectedService: 'CONSULTA',
      context: {
        serviceType: 'CONSULTA',
        options: [{ value: 'b-1', label: 'Saudy' }],
        lastPrompt: 'Qual unidade você deseja?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'unidade invalida',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Qual unidade você deseja?');
  });

  it('asks for insurance after valid unit selection when no insured patient exists in selected unit', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockReset();
    mockedPrisma.patient.findMany.mockReset();
    mockedPrisma.patient.findMany.mockResolvedValue([]);
    mockedPrisma.insurance.findMany.mockResolvedValueOnce([
      { id: 'ins-1', name: 'Unimed' },
    ]);
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_UNIT',
      selectedService: 'CONSULTA',
      context: {
        serviceType: 'CONSULTA',
        options: [{ value: 'b-1', label: 'Saudy' }],
        lastPrompt: 'Qual unidade você deseja?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '1',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Qual é o seu convênio na unidade Saudy?');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_INSURANCE',
        patientId: null,
        patientName: null,
      }),
    }));
  });

  it('moves from unit selection directly to procedures when patient already has insurance on selected branch', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_UNIT',
      selectedService: 'CONSULTA',
      context: {
        serviceType: 'CONSULTA',
        options: [{ value: 'b-1', label: 'Saudy' }],
        lastPrompt: 'Qual unidade você deseja?',
      },
    }));
    mockedPrisma.patient.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'p-1',
          name: 'Maria',
          cpf: '52998224725',
          healthInsuranceName: 'Unimed',
          updatedAt: new Date(),
        },
      ]);
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([
      { id: 'proc-1', name: 'Consulta clínica', acceptsInsurance: true, acceptedInsurances: ['Unimed'] },
    ]);

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '1',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('encontrei o convênio Unimed');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_PROCEDURE',
        patientId: 'p-1',
        patientName: 'Maria',
      }),
    }));
  });

  it('hands off from insurance state when user chooses handoff option', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_INSURANCE',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        options: [
          { value: '__HANDOFF__', label: 'Não encontrei o meu convênio' },
        ],
        lastPrompt: 'Qual é o seu convênio?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '1',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('protocolo');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'HANDED_OFF',
      }),
    }));
  });

  it('repeats insurance prompt when selected insurance option is invalid', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_INSURANCE',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        options: [{ value: 'seguro-1', label: 'Unimed' }],
        lastPrompt: 'Qual é o seu convênio?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'opcao invalida',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Qual é o seu convênio?');
  });

  it('moves from insurance selection to procedure options list', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_INSURANCE',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        options: [
          { value: 'seguro-1', label: 'Unimed' },
        ],
        lastPrompt: 'Qual é o seu convênio?',
      },
    }));
    mockedPrisma.procedure.findMany.mockResolvedValueOnce([
      { id: 'proc-1', name: 'Consulta clínica', acceptsInsurance: true, acceptedInsurances: [] },
    ]);

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '1',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Qual procedimento você deseja?');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_PROCEDURE',
      }),
    }));
  });

  it('repeats procedure prompt when selected procedure option is invalid', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PROCEDURE',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedInsurance: 'Unimed',
        options: [{ value: 'proc-1', label: 'Consulta clínica' }],
        lastPrompt: 'Qual procedimento você deseja?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'opcao invalida',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Qual procedimento você deseja?');
  });

  it('moves procedure state to procedure-not-found action when handoff option is selected', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PROCEDURE',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        selectedInsurance: 'Unimed',
        options: [{ value: '__HANDOFF__', label: 'Não encontrei o meu procedimento' }],
        lastPrompt: 'Qual procedimento você deseja?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '1',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('O que você deseja fazer agora?');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_PROCEDURE_NOT_FOUND_ACTION',
      }),
    }));
  });

  it('opens handoff when selected procedure has no automatic slot available', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-01-01T23:59:00.000Z'));

    mockedPrisma.procedure.findFirst.mockReset();
    mockedPrisma.procedureDoctor.findMany.mockReset();
    mockedPrisma.doctor.findMany.mockReset();
    mockedPrisma.appointment.findMany.mockReset();

    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PROCEDURE',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        selectedInsurance: 'Unimed',
        options: [{ value: 'proc-1', label: 'Consulta clínica' }],
        lastPrompt: 'Qual procedimento você deseja?',
      },
    }));
    mockedPrisma.procedure.findFirst
      .mockResolvedValueOnce({ id: 'proc-1', name: 'Consulta clínica', durationMinutes: 600, price: null })
      .mockResolvedValueOnce({ id: 'proc-1', name: 'Consulta clínica', durationMinutes: 600, price: null });
    mockedPrisma.procedureDoctor.findMany.mockResolvedValue([{ doctorId: 'doc-1' }]);
    mockedPrisma.doctor.findMany.mockResolvedValue([
      {
        id: 'doc-1',
        name: 'Dr. Sem Janela',
        isActive: true,
        workingDays: [],
        workingHoursStart: '08:00',
        workingHoursEnd: '08:00',
        workingSchedules: [
          {
            days: ['SEGUNDA', 'TERCA', 'QUARTA', 'QUINTA', 'SEXTA', 'SABADO', 'DOMINGO'],
            hoursStart: '08:00',
            hoursEnd: '08:00',
          },
        ],
      },
    ]);
    mockedPrisma.appointment.findMany.mockResolvedValue([]);

    try {
      const result = await handleWhatsAppChatbot({
        phone: '5511999998888',
        text: '1',
        branchIdHint: 'b-1',
      });

      expect(result.handled).toBe(true);
      expect(result.response?.text).toContain('encaminhar você para um dos nossos atendentes');
      expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          state: 'HANDED_OFF',
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves procedure state to slot confirmation when a slot is available', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-01-01T08:00:00.000Z'));

    mockedPrisma.procedure.findFirst.mockReset();
    mockedPrisma.procedureDoctor.findMany.mockReset();
    mockedPrisma.doctor.findMany.mockReset();
    mockedPrisma.appointment.findMany.mockReset();

    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PROCEDURE',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        selectedInsurance: 'Unimed',
        options: [{ value: 'proc-1', label: 'Consulta clínica' }],
        lastPrompt: 'Qual procedimento você deseja?',
      },
    }));
    mockedPrisma.procedure.findFirst
      .mockResolvedValueOnce({ id: 'proc-1', name: 'Consulta clínica', durationMinutes: 30, price: null })
      .mockResolvedValueOnce({ id: 'proc-1', name: 'Consulta clínica', durationMinutes: 30, price: null });
    mockedPrisma.procedureDoctor.findMany.mockResolvedValue([{ doctorId: 'doc-1' }]);
    mockedPrisma.doctor.findMany.mockResolvedValue([
      {
        id: 'doc-1',
        name: 'Dr. Teste',
        isActive: true,
        workingDays: ['SEGUNDA', 'TERCA', 'QUARTA', 'QUINTA', 'SEXTA', 'SABADO', 'DOMINGO'],
        workingHoursStart: '08:00',
        workingHoursEnd: '18:00',
      },
    ]);
    mockedPrisma.appointment.findMany.mockResolvedValue([]);

    try {
      const result = await handleWhatsAppChatbot({
        phone: '5511999998888',
        text: '1',
        branchIdHint: 'b-1',
      });

      expect(result.handled).toBe(true);
      expect(result.response?.text).toContain('Deseja seguir com esse horário?');
      expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          state: 'AWAITING_SLOT_CONFIRMATION',
        }),
      }));
    } finally {
      vi.useRealTimers();
    }

  });

  it('returns handoff when selected procedure is invalid in procedure state', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PROCEDURE',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        selectedInsurance: 'Unimed',
        options: [{ value: 'p-x', label: 'Consulta XPTO' }],
        lastPrompt: 'Qual procedimento você deseja?',
      },
    }));
    mockedPrisma.procedure.findFirst.mockResolvedValueOnce(null);

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '1',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('atendentes');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ state: 'HANDED_OFF' }),
    }));
  });

  it('asks again when preferred date is invalid', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PREFERRED_DATE',
      context: {
        selectedProcedureId: 'p-1',
        lastPrompt: 'Qual é a sua preferência de dia?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'data ruim',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Não consegui entender a data');
  });

  it('opens handoff when preferred date cannot produce a slot', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PREFERRED_DATE',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        selectedInsurance: 'Unimed',
        selectedProcedureId: null,
        selectedProcedureName: 'Consulta clínica',
        lastPrompt: 'Qual é a sua preferência de dia?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'amanhã',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('encaminhar você para um dos nossos atendentes');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'HANDED_OFF',
      }),
    }));
  });

  it('moves preferred date flow to slot confirmation when a slot is found', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_PREFERRED_DATE',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedProcedureId: 'proc-1',
        selectedProcedureName: 'Consulta clínica',
        selectedInsurance: 'Unimed',
        lastPrompt: 'Qual é a sua preferência de dia?',
      },
    }));
    mockedPrisma.procedureDoctor.findMany.mockResolvedValueOnce([
      { doctorId: 'doc-1' },
    ]);
    mockedPrisma.procedure.findFirst.mockResolvedValueOnce({
      id: 'proc-1',
      name: 'Consulta clínica',
      durationMinutes: 30,
      price: null,
    });
    mockedPrisma.doctor.findMany.mockResolvedValueOnce([
      {
        id: 'doc-1',
        name: 'Dr. Teste',
        isActive: true,
        workingDays: ['SEGUNDA', 'TERCA', 'QUARTA', 'QUINTA', 'SEXTA'],
        workingHoursStart: '08:00',
        workingHoursEnd: '18:00',
      },
    ]);
    mockedPrisma.appointment.findMany.mockResolvedValueOnce([]);

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '15/04/2099',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Deseja seguir com esse horário?');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_SLOT_CONFIRMATION',
      }),
    }));
  });

  it('repeats slot confirmation prompt when answer is not yes/no', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_SLOT_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedProcedureId: 'proc-1',
        selectedProcedureName: 'Consulta clínica',
        selectedDoctorId: 'doc-1',
        selectedDoctorName: 'Dr. Teste',
        selectedInsurance: 'Unimed',
        suggestedDate: '2099-01-01',
        suggestedTime: '09:00',
        suggestedDurationMinutes: 30,
        lastPrompt: 'Deseja seguir com esse horário?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'talvez',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Deseja seguir com esse horário?');
  });

  it('returns to preferred-date step when slot confirmation is denied', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_SLOT_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedProcedureId: 'proc-1',
        selectedProcedureName: 'Consulta clínica',
        selectedDoctorId: 'doc-1',
        selectedDoctorName: 'Dr. Teste',
        selectedInsurance: 'Unimed',
        suggestedDate: '2099-01-01',
        suggestedTime: '09:00',
        suggestedDurationMinutes: 30,
        lastPrompt: 'Deseja seguir com esse horário?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'não',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('preferência de dia');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_PREFERRED_DATE',
      }),
    }));
  });

  it('goes to final confirmation when slot is accepted and patient data is already collected', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_SLOT_CONFIRMATION',
      patientId: 'p-1',
      patientName: 'Maria',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        selectedProcedureId: 'proc-1',
        selectedProcedureName: 'Consulta clínica',
        selectedDoctorId: 'doc-1',
        selectedDoctorName: 'Dr. Teste',
        selectedInsurance: 'Unimed',
        suggestedDate: '2099-01-01',
        suggestedTime: '09:00',
        suggestedDurationMinutes: 30,
        lastPrompt: 'Deseja seguir com esse horário?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'sim',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Confirma os dados abaixo?');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_FINAL_CONFIRMATION',
      }),
    }));
  });

  it('routes slot confirmation accepted flow to cpf collection when patient data is incomplete', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_SLOT_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedProcedureId: 'proc-1',
        selectedProcedureName: 'Consulta clínica',
        selectedDoctorId: 'doc-1',
        selectedDoctorName: 'Dr. Teste',
        selectedInsurance: 'Unimed',
        suggestedDate: '2099-01-01',
        suggestedTime: '09:00',
        suggestedDurationMinutes: 30,
        lastPrompt: 'Deseja seguir com esse horário?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'sim',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('informe seu CPF');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_CPF',
      }),
    }));
  });

  it('validates new patient name length and birthdate format branches', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_NEW_PATIENT_NAME',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        lastPrompt: 'Perfeito. Agora informe seu nome completo.',
      },
    }));

    const shortName = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'Al',
      branchIdHint: 'b-1',
    });

    expect(shortName.handled).toBe(true);
    expect(shortName.response?.text).toContain('nome completo');

    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_NEW_PATIENT_BIRTHDATE',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        nameCandidate: 'Alice Teste',
        lastPrompt: 'Informe sua data de nascimento no formato DD/MM/AAAA.',
      },
    }));

    const invalidBirthDate = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '32/13/2000',
      branchIdHint: 'b-1',
    });

    expect(invalidBirthDate.handled).toBe(true);
    expect(invalidBirthDate.response?.text).toContain('Data inválida');
  });

  it('moves from valid new patient name to birthdate step when birthdate is still missing', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_NEW_PATIENT_NAME',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedInsurance: 'Unimed',
        selectedProcedureName: 'Consulta clínica',
        selectedDoctorName: 'Dr. Teste',
        suggestedDate: '2099-01-01',
        suggestedTime: '09:00',
        lastPrompt: 'Perfeito. Agora informe seu nome completo.',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'Alice Teste',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('data de nascimento');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_NEW_PATIENT_BIRTHDATE',
      }),
    }));
  });

  it('builds final summary when final confirmation has no cached prompt', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_FINAL_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchName: 'Saudy',
        selectedInsurance: 'Unimed',
        selectedProcedureName: 'Consulta clínica',
        selectedDoctorName: 'Dr. Teste',
        suggestedDate: '2099-01-01',
        suggestedTime: '09:00',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'talvez',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Confirma os dados abaixo?');
    expect(result.response?.binaryOptions).toBe(true);
  });

  it('goes to final confirmation when cpf confirmation resolves existing patient', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_CPF_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        selectedInsurance: 'Unimed',
        selectedProcedureName: 'Consulta clínica',
        selectedDoctorName: 'Dr. Teste',
        suggestedDate: '2099-01-01',
        suggestedTime: '09:00',
        cpfCandidate: '52998224725',
        lastPrompt: 'Confirma o CPF informado?',
      },
    }));
    mockedPrisma.patient.findFirst.mockResolvedValueOnce({
      id: 'p-1',
      name: 'Maria',
      cpf: '52998224725',
      healthInsuranceName: 'Unimed',
    });

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'sim',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Confirma os dados abaixo?');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_FINAL_CONFIRMATION',
        patientId: 'p-1',
      }),
    }));
  });

  it('asks new patient name when cpf is confirmed but no existing patient is found', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_CPF_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        selectedInsurance: 'Unimed',
        selectedProcedureName: 'Consulta clínica',
        selectedDoctorName: 'Dr. Teste',
        suggestedDate: '2099-01-01',
        suggestedTime: '09:00',
        cpfCandidate: '52998224725',
        lastPrompt: 'Confirma o CPF informado?',
      },
    }));
    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null);

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'sim',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('informe seu nome completo');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_NEW_PATIENT_NAME',
      }),
    }));
  });

  it('repeats cpf confirmation prompt when answer is not yes/no', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_CPF_CONFIRMATION',
      context: {
        selectedBranchId: 'b-1',
        cpfCandidate: '52998224725',
        lastPrompt: 'Confirma o CPF informado?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'talvez',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Confirma o CPF informado?');
  });

  it('jumps from new patient name directly to final summary when birthdate is already known', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_NEW_PATIENT_NAME',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        selectedInsurance: 'Unimed',
        selectedProcedureName: 'Consulta clínica',
        selectedDoctorName: 'Dr. Teste',
        suggestedDate: '2099-01-01',
        suggestedTime: '09:00',
        birthDateCandidate: '1990-01-01',
        lastPrompt: 'Perfeito. Agora informe seu nome completo.',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'Alice Teste',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Confirma os dados abaixo?');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_FINAL_CONFIRMATION',
      }),
    }));
  });

  it('goes from valid new patient birthdate to final summary', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_NEW_PATIENT_BIRTHDATE',
      patientName: 'Alice Teste',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        selectedInsurance: 'Unimed',
        selectedProcedureName: 'Consulta clínica',
        selectedDoctorName: 'Dr. Teste',
        suggestedDate: '2099-01-01',
        suggestedTime: '09:00',
        nameCandidate: 'Alice Teste',
        lastPrompt: 'Informe sua data de nascimento no formato DD/MM/AAAA.',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '01/01/1990',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Confirma os dados abaixo?');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'AWAITING_FINAL_CONFIRMATION',
      }),
    }));
  });

  it('returns graceful handoff message when final confirmation lacks required data', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_FINAL_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedInsurance: 'Unimed',
        selectedProcedureName: null,
        selectedDoctorName: 'Dr. Teste',
        suggestedDate: '2099-01-01',
        suggestedTime: '09:00',
        lastPrompt: 'Confirma os dados abaixo?',
      },
    }));

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: '1',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('Não consegui concluir o agendamento');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ state: 'HANDED_OFF' }),
    }));
  });

  it('completes appointment when final confirmation is accepted with all required data', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_FINAL_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        selectedInsurance: 'Unimed',
        selectedProcedureName: 'Consulta clínica',
        selectedDoctorId: 'd-1',
        selectedDoctorName: 'Dr. Teste',
        suggestedDate: '2099-01-01',
        suggestedTime: '09:00',
        suggestedDurationMinutes: 30,
        cpfCandidate: '52998224725',
        nameCandidate: 'Maria',
        birthDateCandidate: '1990-01-01',
        lastPrompt: 'Confirma os dados abaixo?',
      },
    }));
    mockedPrisma.patient.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockedPrisma.patient.create.mockResolvedValueOnce({
      id: 'p-1',
      name: 'Maria',
      cpf: '52998224725',
      healthInsuranceName: 'Unimed',
    });

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'sim',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('solicitação foi registrada');
    expect(mockedPrisma.$transaction).toHaveBeenCalled();
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'COMPLETED',
      }),
    }));
  });

  it('completes appointment without linked patient when identification data is missing', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_FINAL_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        selectedInsurance: 'Unimed',
        selectedProcedureName: 'Consulta clínica',
        selectedDoctorId: 'd-1',
        selectedDoctorName: 'Dr. Teste',
        suggestedDate: '2099-01-01',
        suggestedTime: '09:00',
        suggestedDurationMinutes: 30,
        preferredDate: '2099-01-03',
        lastPrompt: 'Confirma os dados abaixo?',
      },
    }));
    mockedPrisma.patient.findMany.mockReset();
    mockedPrisma.patient.findMany.mockResolvedValue([]);

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'sim',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('solicitação foi registrada');
    expect(mockedPrisma.whatsAppConversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        state: 'COMPLETED',
        patientId: null,
      }),
    }));
  });

  it('updates existing patient at selected branch during final confirmation acceptance', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_FINAL_CONFIRMATION',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        selectedInsurance: 'Unimed',
        selectedProcedureName: 'Consulta clínica',
        selectedDoctorId: 'd-1',
        selectedDoctorName: 'Dr. Teste',
        suggestedDate: '2099-01-01',
        suggestedTime: '09:00',
        suggestedDurationMinutes: 30,
        cpfCandidate: '52998224725',
        nameCandidate: 'Maria',
        birthDateCandidate: '1990-01-01',
        lastPrompt: 'Confirma os dados abaixo?',
      },
    }));
    mockedPrisma.patient.findMany.mockReset();
    mockedPrisma.patient.findMany.mockResolvedValue([]);
    mockedPrisma.patient.findFirst.mockReset();
    mockedPrisma.patient.findFirst.mockResolvedValueOnce({
      id: 'p-existing',
      name: 'Maria',
      cpf: '52998224725',
      healthInsuranceName: 'Unimed',
    });

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'sim',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('solicitação foi registrada');
    expect(mockedPrisma.patient.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'p-existing' },
    }));
    expect(mockedPrisma.patient.create).not.toHaveBeenCalled();
  });

  it('resolves patient by conversation.patientId during final confirmation acceptance', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_FINAL_CONFIRMATION',
      patientId: 'p-1',
      patientName: 'Maria',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        selectedInsurance: 'Unimed',
        selectedProcedureName: 'Consulta clínica',
        selectedDoctorId: 'd-1',
        selectedDoctorName: 'Dr. Teste',
        suggestedDate: '2099-01-01',
        suggestedTime: '09:00',
        suggestedDurationMinutes: 30,
        lastPrompt: 'Confirma os dados abaixo?',
      },
    }));
    mockedPrisma.patient.findFirst.mockResolvedValueOnce({
      id: 'p-1',
      name: 'Maria',
      cpf: '52998224725',
      healthInsuranceName: 'Unimed',
    });

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'sim',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('solicitação foi registrada');
    expect(mockedPrisma.patient.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'p-1' }),
    }));
  });

  it('maps conversation patient into resolved patient payload before reservation', async () => {
    mockedPrisma.whatsAppConversation.findUnique.mockResolvedValueOnce(makeConversation({
      state: 'AWAITING_FINAL_CONFIRMATION',
      patientId: 'p-map',
      patientName: 'Paciente Mapeado',
      context: {
        serviceType: 'CONSULTA',
        selectedBranchId: 'b-1',
        selectedBranchName: 'Saudy',
        selectedInsurance: 'Unimed',
        selectedProcedureName: 'Consulta clínica',
        selectedDoctorId: 'd-1',
        selectedDoctorName: 'Dr. Teste',
        suggestedDate: '2099-01-01',
        suggestedTime: '09:00',
        suggestedDurationMinutes: 30,
        lastPrompt: 'Confirma os dados abaixo?',
      },
    }));
    mockedPrisma.patient.findMany.mockResolvedValueOnce([]);
    mockedPrisma.patient.findFirst.mockImplementationOnce(async (args: any) => {
      if (args?.where?.id === 'p-map') {
        return {
          id: 123,
          name: 'Paciente Mapeado',
          cpf: '52998224725',
          healthInsuranceName: 'Unimed',
        };
      }
      return null;
    });

    const result = await handleWhatsAppChatbot({
      phone: '5511999998888',
      text: 'sim',
      branchIdHint: 'b-1',
    });

    expect(result.handled).toBe(true);
    expect(result.response?.text).toContain('solicitação foi registrada');
    expect(mockedPrisma.patient.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'p-map' }),
    }));
  });
});
