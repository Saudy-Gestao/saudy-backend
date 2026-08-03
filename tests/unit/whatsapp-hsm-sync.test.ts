import { beforeEach, describe, expect, it, vi } from 'vitest';
import prisma from '../../src/modules/care/lib/prisma';
import { syncAllBranchesHsmTemplates, syncBranchHsmTemplates } from '../../src/modules/care/lib/whatsapp-hsm-sync';

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    whatsAppConfig: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    whatsAppMessageTemplate: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

const mockedPrisma = prisma as any;

// Helper to mock successful WABA ID lookup + templates fetch
function mockWabaAndTemplates(templates: any[]) {
  (globalThis.fetch as any)
    // First call: getWabaId
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ whatsapp_business_account: { id: 'waba-1' } }),
    })
    // Second call: fetchMetaTemplates
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: templates, paging: {} }),
    });
}

describe('whatsapp hsm sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).fetch = vi.fn();
    delete process.env.WHATSAPP_WABA_ID;

    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValue({
      branchId: 'b-1',
      appId: 'app-1',
      accountSid: 'api-key',
    });
    mockedPrisma.whatsAppMessageTemplate.findMany.mockResolvedValue([
      {
        id: 't-1',
        name: 'Confirmação de Agendamento',
        hsmTemplateName: 'confirmacao_de_agendamento_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        hsmTemplateId: null,
        hsmTemplateStatus: null,
        hsmTemplateApproved: false,
      },
      {
        id: 't-2',
        name: 'Resumo de Agendamento',
        hsmTemplateName: null,
        hsmTemplateId: 'remote-2',
        hsmTemplateStatus: 'PENDING',
        hsmTemplateApproved: false,
      },
    ]);
    mockedPrisma.whatsAppMessageTemplate.update.mockResolvedValue({ id: 't-1' });
  });

  it('throws when whatsapp credentials are missing', async () => {
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ appId: '', accountSid: '' });

    await expect(syncBranchHsmTemplates('b-1')).rejects.toThrow('Credenciais do WhatsApp');
  });

  it('throws when meta list request fails', async () => {
    // WABA ID lookup succeeds, but templates fetch fails
    (globalThis.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ whatsapp_business_account: { id: 'waba-1' } }),
      })
      .mockResolvedValueOnce({ ok: false, text: async () => 'provider down' });

    await expect(syncBranchHsmTemplates('b-1')).rejects.toThrow('Erro ao listar templates da Meta');
  });

  it('syncs templates by name, id and base-name variants', async () => {
    mockWabaAndTemplates([
      { name: 'confirmacao_de_agendamento_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', id: 'remote-1', status: 'APPROVED' },
      { name: 'resumo_de_agendamento_uuid', id: 'remote-2', status: 'REJECTED' },
    ]);

    const result = await syncBranchHsmTemplates('b-1');

    expect(result.updated).toBeGreaterThan(0);
    expect(result.synced).toBe(1);
    expect(Object.keys(result.metaTemplates)).toContain('confirmacao_de_agendamento_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(mockedPrisma.whatsAppMessageTemplate.update).toHaveBeenCalled();
  });

  it('syncAllBranches aggregates successful branches and ignores invalid configs', async () => {
    mockedPrisma.whatsAppConfig.findMany.mockResolvedValueOnce([
      { branchId: 'b-1', appId: 'app-1', accountSid: 'api-key' },
      { branchId: 'b-2', appId: '', accountSid: 'api-key' },
      { branchId: null, appId: 'app-3', accountSid: 'api-key' },
    ]);

    // mock for b-1 only (b-2 and null are skipped by the source)
    process.env.WHATSAPP_WABA_ID = 'waba-env';
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { name: 'confirmacao_de_agendamento_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', id: 'remote-1', status: 'APPROVED' },
        ],
        paging: {},
      }),
    });

    const result = await syncAllBranchesHsmTemplates();

    expect(result.branches).toBe(1);
    expect(result.synced).toBeGreaterThanOrEqual(0);

    delete process.env.WHATSAPP_WABA_ID;
  });

  it('syncAllBranches continues when one branch fails', async () => {
    mockedPrisma.whatsAppConfig.findMany.mockResolvedValueOnce([
      { branchId: 'b-1', appId: 'app-1', accountSid: 'api-key' },
      { branchId: 'b-2', appId: 'app-2', accountSid: 'api-key' },
    ]);

    process.env.WHATSAPP_WABA_ID = 'waba-env';
    (globalThis.fetch as any)
      // b-1 templates fetch fails
      .mockResolvedValueOnce({ ok: false, text: async () => 'fail-1' })
      // b-2 templates fetch succeeds
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [], paging: {} }),
      });

    const result = await syncAllBranchesHsmTemplates();

    expect(result.branches).toBe(1);

    delete process.env.WHATSAPP_WABA_ID;
  });
});
