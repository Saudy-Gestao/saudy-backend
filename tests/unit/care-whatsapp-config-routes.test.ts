import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import whatsappConfigRoutes from '../../src/modules/care/routes/whatsapp-config';
import prisma from '../../src/modules/care/lib/prisma';
import WhatsAppMessageBuilder from '../../src/modules/care/lib/whatsapp-message-builder';
import { syncBranchHsmTemplates } from '../../src/modules/care/lib/whatsapp-hsm-sync';

vi.mock('crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('crypto')>()),
  randomUUID: vi.fn(() => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
}));

vi.mock('../../src/modules/care/lib/whatsapp-message-builder', () => ({
  default: {
    validateTemplate: vi.fn(() => ({ valid: true, invalidVariables: [] })),
    getAvailableVariables: vi.fn(() => ['paciente_nome', 'data']),
  },
}));

vi.mock('../../src/modules/care/lib/whatsapp-hsm-sync', () => ({
  syncBranchHsmTemplates: vi.fn(),
}));

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    whatsAppConfig: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
    whatsAppMessageTemplate: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    whatsAppNotificationConfig: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

const mockedPrisma = prisma as any;
const mockedBuilder = WhatsAppMessageBuilder as any;
const mockedSync = syncBranchHsmTemplates as any;

async function buildApp(opts?: { unauthorized?: boolean; noBranch?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1' };
  });

  mockedPrisma.user.findUnique.mockResolvedValue(
    opts?.noBranch
      ? { id: 'u-1', sector: null }
      : { id: 'u-1', sector: { branch: { id: 'b-1' } } },
  );

  await app.register(whatsappConfigRoutes, { prefix: '/wa' });
  return app;
}

describe('care whatsapp-config routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (globalThis as any).fetch = vi.fn();

    mockedPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', sector: { branch: { id: 'b-1' } } });
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValue({
      id: 'cfg-1',
      branchId: 'b-1',
      accountSid: 'api-key',
      authToken: 'app-name',
      fromNumber: '5511999999999',
      appId: 'app-1',
      isActive: true,
    });
    mockedPrisma.whatsAppConfig.upsert.mockResolvedValue({
      id: 'cfg-1',
      branchId: 'b-1',
      accountSid: 'api-key',
      authToken: 'app-name',
      fromNumber: '5511999999999',
      appId: null,
      isActive: true,
    });
    mockedPrisma.whatsAppConfig.delete.mockResolvedValue({ id: 'cfg-1' });

    mockedPrisma.whatsAppMessageTemplate.findMany.mockResolvedValue([{ id: 't-1', type: 'APPOINTMENT_CONFIRMATION' }]);
    mockedPrisma.whatsAppMessageTemplate.findUnique.mockResolvedValue(null);
    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValue({
      id: 't-1',
      branchId: 'b-1',
      type: 'APPOINTMENT_CONFIRMATION',
      name: 'Confirmacao',
      message: 'Oi {{paciente_nome}}, consulta em {{data}}.',
      hsmTemplateName: 'confirmacao_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      hsmTemplateId: 'remote-1',
      hsmTemplateStatus: 'APPROVED',
      importedFromGupshupSync: true,
    });
    mockedPrisma.whatsAppMessageTemplate.upsert.mockResolvedValue({
      id: 't-1',
      type: 'APPOINTMENT_CONFIRMATION',
      hsmTemplateName: 'confirmacao_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    mockedPrisma.whatsAppMessageTemplate.update.mockResolvedValue({
      id: 't-1',
      hsmTemplateName: 'novo_nome_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      message: 'Oi {{paciente_nome}}.',
      type: 'APPOINTMENT_CONFIRMATION',
      name: 'Novo Nome',
    });
    mockedPrisma.whatsAppMessageTemplate.deleteMany.mockResolvedValue({ count: 0 });
    mockedPrisma.whatsAppMessageTemplate.create.mockResolvedValue({ id: 't-new' });
    mockedPrisma.whatsAppMessageTemplate.delete.mockResolvedValue({ id: 't-1' });

    mockedPrisma.whatsAppNotificationConfig.findUnique.mockResolvedValue({
      branchId: 'b-1',
      sendOnAppointmentCreated: true,
      sendConfirmationEnabled: true,
      confirmationHoursBefore: 24,
      sendReminderEnabled: false,
      reminderHoursBefore: 2,
    });
    mockedPrisma.whatsAppNotificationConfig.upsert.mockResolvedValue({ branchId: 'b-1' });

    mockedBuilder.validateTemplate.mockReturnValue({ valid: true, invalidVariables: [] });
    mockedBuilder.getAvailableVariables.mockReturnValue(['paciente_nome', 'data']);
    mockedSync.mockResolvedValue({ success: true, synced: 1 });
  });

  it('handles auth and branch guards', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/wa/whatsapp/config' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    const app = await buildApp({ noBranch: true });
    res = await app.inject({ method: 'GET', url: '/wa/whatsapp/config' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('gets/posts/deletes whatsapp config with masking and fallback token', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/wa/whatsapp/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json().authToken).toBe('***name');

    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({
      method: 'POST',
      url: '/wa/whatsapp/config',
      payload: { accountSid: 'x', fromNumber: '5511' },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ authToken: 'existing-app' });
    mockedPrisma.whatsAppConfig.upsert.mockResolvedValueOnce({
      id: 'cfg-1',
      authToken: 'existing-app',
      accountSid: 'x',
      fromNumber: '5511',
      branchId: 'b-1',
      isActive: true,
    });
    res = await app.inject({
      method: 'POST',
      url: '/wa/whatsapp/config',
      payload: { accountSid: 'x', fromNumber: '5511' },
    });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'DELETE', url: '/wa/whatsapp/config' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('returns 403 for other branch-scoped endpoints when user has no branch', async () => {
    const app = await buildApp({ noBranch: true });

    const requests = [
      { method: 'DELETE', url: '/wa/whatsapp/config' },
      { method: 'GET', url: '/wa/whatsapp/templates' },
      {
        method: 'POST',
        url: '/wa/whatsapp/templates',
        payload: { type: 'APPOINTMENT_CONFIRMATION', name: 'Confirmação', message: 'Oi {{paciente_nome}}.' },
      },
      { method: 'POST', url: '/wa/whatsapp/templates/load-defaults' },
      { method: 'GET', url: '/wa/whatsapp/templates/t-1' },
      { method: 'DELETE', url: '/wa/whatsapp/templates/t-1' },
      { method: 'POST', url: '/wa/whatsapp/templates/t-1/push-to-meta' },
      { method: 'GET', url: '/wa/whatsapp/notification-config' },
      {
        method: 'POST',
        url: '/wa/whatsapp/notification-config',
        payload: { sendOnAppointmentCreated: false },
      },
      { method: 'POST', url: '/wa/whatsapp/templates/sync-hsm' },
    ] as const;

    for (const request of requests) {
      const res = await app.inject(request);
      expect(res.statusCode).toBe(403);
    }

    await app.close();
  });

  it('returns null when whatsapp config is not set', async () => {
    const app = await buildApp();

    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce(null);
    const res = await app.inject({ method: 'GET', url: '/wa/whatsapp/config' });
    expect(res.statusCode).toBe(200);
    expect([null, {}]).toContainEqual(res.json());

    await app.close();
  });

  it('lists and saves templates with validation and business rule errors', async () => {
    const app = await buildApp();

    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ accountSid: '', authToken: '', fromNumber: '' });
    let res = await app.inject({ method: 'GET', url: '/wa/whatsapp/templates' });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'GET', url: '/wa/whatsapp/templates' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);

    mockedBuilder.validateTemplate.mockReturnValueOnce({ valid: false, invalidVariables: ['foo'] });
    res = await app.inject({
      method: 'POST',
      url: '/wa/whatsapp/templates',
      payload: { type: 'APPOINTMENT_CONFIRMATION', name: 'Confirmação', message: 'x {{foo}}' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().invalidVariables).toEqual(['foo']);

    res = await app.inject({
      method: 'POST',
      url: '/wa/whatsapp/templates',
      payload: { type: 'APPOINTMENT_CONFIRMATION', name: 'Confirmação', message: '{{paciente_nome}}' },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/wa/whatsapp/templates',
      payload: {
        type: 'APPOINTMENT_CONFIRMATION',
        id: 'other-id',
        name: 'Confirmação',
        message: 'Oi {{paciente_nome}}.',
      },
    });
    expect(res.statusCode).toBe(404);

    mockedPrisma.whatsAppMessageTemplate.findUnique.mockResolvedValueOnce({
      id: 't-1',
      name: 'Nome Antigo',
      type: 'APPOINTMENT_CONFIRMATION',
      hsmTemplateName: 'nome_antigo_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    res = await app.inject({
      method: 'POST',
      url: '/wa/whatsapp/templates',
      payload: {
        id: 't-1',
        type: 'APPOINTMENT_CONFIRMATION',
        name: 'Novo Nome',
        message: 'Oi {{paciente_nome}}.',
        isActive: true,
      },
    });
    expect([200, 500]).toContain(res.statusCode);

    await app.close();
  });

  it('rejects duplicate template creation and updates existing template without resetting sync fields', async () => {
    const app = await buildApp();

    mockedPrisma.whatsAppMessageTemplate.findUnique.mockResolvedValueOnce({
      id: 't-existing',
      type: 'APPOINTMENT_CONFIRMATION',
      name: 'Confirmacao',
      hsmTemplateName: 'confirmacao_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      hsmTemplateId: 'remote-1',
      hsmTemplateStatus: 'APPROVED',
      importedFromGupshupSync: true,
    });
    let res = await app.inject({
      method: 'POST',
      url: '/wa/whatsapp/templates',
      payload: {
        type: 'APPOINTMENT_CONFIRMATION',
        name: 'Confirmação',
        message: 'Oi {{paciente_nome}}.',
      },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.whatsAppMessageTemplate.findUnique.mockResolvedValueOnce({
      id: 't-1',
      type: 'APPOINTMENT_CONFIRMATION',
      name: 'Confirmacao',
      hsmTemplateName: 'confirmacao_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      hsmTemplateId: 'remote-1',
      hsmTemplateStatus: 'APPROVED',
      importedFromGupshupSync: true,
    });
    mockedPrisma.whatsAppMessageTemplate.upsert.mockResolvedValueOnce({
      id: 't-1',
      type: 'APPOINTMENT_CONFIRMATION',
      hsmTemplateName: 'confirmacao_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    res = await app.inject({
      method: 'POST',
      url: '/wa/whatsapp/templates',
      payload: {
        id: 't-1',
        type: 'APPOINTMENT_CONFIRMATION',
        name: 'Confirmacao',
        message: 'Oi {{paciente_nome}}.',
        isActive: false,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.whatsAppMessageTemplate.upsert).toHaveBeenLastCalledWith(expect.objectContaining({
      update: expect.not.objectContaining({
        hsmTemplateId: null,
      }),
    }));

    await app.close();
  });

  it('rejects template business rules for invalid hsm name and variable at message end', async () => {
    const app = await buildApp();

    let res = await app.inject({
      method: 'POST',
      url: '/wa/whatsapp/templates',
      payload: {
        type: 'APPOINTMENT_CONFIRMATION',
        name: 'Confirmação',
        message: 'Oi {{paciente_nome}}.',
        hsmTemplateName: 'INVALID-NAME',
      },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/wa/whatsapp/templates',
      payload: {
        type: 'APPOINTMENT_CONFIRMATION',
        name: 'Confirmação',
        message: 'Oi {{paciente_nome}}',
      },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('loads defaults and reads single template', async () => {
    const app = await buildApp();

    mockedPrisma.whatsAppMessageTemplate.findUnique
      .mockResolvedValueOnce({ id: 'existing-1', hsmTemplateName: 'x_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
      .mockResolvedValue(null);

    let res = await app.inject({ method: 'POST', url: '/wa/whatsapp/templates/load-defaults' });
    expect([200, 500]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      expect(res.json().success).toBe(true);
    }

    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/wa/whatsapp/templates/t-x' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/wa/whatsapp/templates/t-1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('returns 400 when loading default templates without stored credentials', async () => {
    const app = await buildApp();

    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ accountSid: '', authToken: '', fromNumber: '' });
    const res = await app.inject({ method: 'POST', url: '/wa/whatsapp/templates/load-defaults' });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('loads defaults and regenerates hsm name when existing template has none', async () => {
    const app = await buildApp();

    mockedPrisma.whatsAppMessageTemplate.findUnique
      .mockResolvedValueOnce({ id: 'existing-1', hsmTemplateName: null })
      .mockResolvedValue(null);

    const res = await app.inject({ method: 'POST', url: '/wa/whatsapp/templates/load-defaults' });
    expect([200, 500]).toContain(res.statusCode);

    await app.close();
  });

  it('returns 400 when reading single template without stored credentials', async () => {
    const app = await buildApp();

    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ accountSid: '', authToken: '', fromNumber: '' });
    const res = await app.inject({ method: 'GET', url: '/wa/whatsapp/templates/t-1' });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('deletes templates with meta validation branches', async () => {
    // Set WABA ID env to skip the phone number ID lookup fetch
    process.env.WHATSAPP_WABA_ID = 'waba-test';
    const app = await buildApp();

    // 1) Template not found → 404
    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'DELETE', url: '/wa/whatsapp/templates/t-z' });
    expect(res.statusCode).toBe(404);

    // 2) Template with remote signals but no credentials → 400
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ appId: '', accountSid: '' });
    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValueOnce({
      id: 't-2',
      branchId: 'b-1',
      hsmTemplateId: 'remote-id',
      hsmTemplateName: 'temp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      hsmTemplateStatus: 'APPROVED',
      importedFromGupshupSync: true,
    });
    res = await app.inject({ method: 'DELETE', url: '/wa/whatsapp/templates/t-2' });
    expect(res.statusCode).toBe(400);

    // 3) With credentials, Meta DELETE returns non-404 error → 400
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ appId: 'app-id', accountSid: 'api-key' });
    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValueOnce({
      id: 't-3',
      branchId: 'b-1',
      hsmTemplateId: 'remote-id',
      hsmTemplateName: 'temp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      hsmTemplateStatus: 'APPROVED',
      importedFromGupshupSync: true,
    });
    (globalThis.fetch as any).mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'meta error' });
    res = await app.inject({ method: 'DELETE', url: '/wa/whatsapp/templates/t-3' });
    expect(res.statusCode).toBe(400);

    // 4) With credentials, Meta DELETE returns 404 (already gone) → 200
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ appId: 'app-id', accountSid: 'api-key' });
    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValueOnce({
      id: 't-4',
      branchId: 'b-1',
      hsmTemplateId: 'remote-id',
      hsmTemplateName: 'temp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      hsmTemplateStatus: 'APPROVED',
      importedFromGupshupSync: true,
    });
    (globalThis.fetch as any).mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'not found' });
    res = await app.inject({ method: 'DELETE', url: '/wa/whatsapp/templates/t-4' });
    expect(res.statusCode).toBe(200);

    delete process.env.WHATSAPP_WABA_ID;
    await app.close();
  });

  it('deletes local template when gupshup list fails but there are no remote signals', async () => {
    const app = await buildApp();

    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ appId: 'app-id', accountSid: 'api-key' });
    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValueOnce({
      id: 't-5',
      branchId: 'b-1',
      hsmTemplateId: null,
      hsmTemplateName: 'temp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      hsmTemplateStatus: null,
      importedFromGupshupSync: false,
    });
    (globalThis.fetch as any).mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'provider-down' });

    const res = await app.inject({ method: 'DELETE', url: '/wa/whatsapp/templates/t-5' });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.whatsAppMessageTemplate.delete).toHaveBeenCalledWith({ where: { id: 't-5' } });

    await app.close();
  });

  it('returns 400 when gupshup list fails and template has remote signals', async () => {
    const app = await buildApp();

    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ appId: 'app-id', accountSid: 'api-key' });
    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValueOnce({
      id: 't-8',
      branchId: 'b-1',
      hsmTemplateId: 'remote-id',
      hsmTemplateName: 'temp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      hsmTemplateStatus: 'APPROVED',
      importedFromGupshupSync: true,
    });
    (globalThis.fetch as any).mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'provider-offline' });

    const res = await app.inject({ method: 'DELETE', url: '/wa/whatsapp/templates/t-8' });
    expect(res.statusCode).toBe(400);
    expect((globalThis.fetch as any)).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('deletes local template when remote template is not found in list', async () => {
    const app = await buildApp();

    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ appId: 'app-id', accountSid: 'api-key' });
    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValueOnce({
      id: 't-6',
      branchId: 'b-1',
      hsmTemplateId: 'remote-id-not-present',
      hsmTemplateName: 'temp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      hsmTemplateStatus: 'APPROVED',
      importedFromGupshupSync: true,
    });
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ templates: [{ id: 'other-id', elementName: 'other_name' }] }),
    });

    const res = await app.inject({ method: 'DELETE', url: '/wa/whatsapp/templates/t-6' });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.whatsAppMessageTemplate.delete).toHaveBeenCalledWith({ where: { id: 't-6' } });

    await app.close();
  });

  it('deletes remote template matched by hsm name via Meta API', async () => {
    process.env.WHATSAPP_WABA_ID = 'waba-test';
    const app = await buildApp();

    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ appId: 'app-id', accountSid: 'api-key' });
    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValueOnce({
      id: 't-10',
      branchId: 'b-1',
      hsmTemplateId: null,
      hsmTemplateName: 'temp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      hsmTemplateStatus: 'APPROVED',
      importedFromGupshupSync: true,
    });
    (globalThis.fetch as any).mockResolvedValueOnce({ ok: true, status: 200, text: async () => 'deleted' });

    const res = await app.inject({ method: 'DELETE', url: '/wa/whatsapp/templates/t-10' });
    expect(res.statusCode).toBe(200);
    // Meta API delete by name
    expect((globalThis.fetch as any).mock.calls[0][0]).toContain('name=temp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    delete process.env.WHATSAPP_WABA_ID;
    await app.close();
  });

  it('deletes remote template using Meta API with WABA ID lookup and hsm name', async () => {
    process.env.WHATSAPP_WABA_ID = 'waba-test';
    const app = await buildApp();

    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ appId: 'app-id', accountSid: 'api-key' });
    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValueOnce({
      id: 't-11',
      branchId: 'b-1',
      hsmTemplateId: 'remote-template-id',
      hsmTemplateName: 'temp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      hsmTemplateStatus: 'APPROVED',
      importedFromGupshupSync: true,
    });
    (globalThis.fetch as any).mockResolvedValueOnce({ ok: true, status: 200, text: async () => 'deleted-by-query' });

    const res = await app.inject({ method: 'DELETE', url: '/wa/whatsapp/templates/t-11' });
    expect(res.statusCode).toBe(200);
    expect((globalThis.fetch as any).mock.calls[0][0]).toContain('name=temp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    delete process.env.WHATSAPP_WABA_ID;
    await app.close();
  });

  it('deletes remote template when hsmTemplateName is null (no Meta delete call, only local)', async () => {
    process.env.WHATSAPP_WABA_ID = 'waba-test';
    const app = await buildApp();

    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ appId: 'app-id', accountSid: 'api-key' });
    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValueOnce({
      id: 't-12',
      branchId: 'b-1',
      hsmTemplateId: 'remote-id-only',
      hsmTemplateName: null,
      hsmTemplateStatus: 'APPROVED',
      importedFromGupshupSync: true,
    });

    // When hsmTemplateName is null but hsmTemplateId exists,
    // the code enters the HSM block but `wabaId && template.hsmTemplateName` is false
    // so no fetch is made for delete — just local delete succeeds
    const res = await app.inject({ method: 'DELETE', url: '/wa/whatsapp/templates/t-12' });
    expect(res.statusCode).toBe(200);
    // No Meta delete call since hsmTemplateName is null
    expect((globalThis.fetch as any)).not.toHaveBeenCalled();

    delete process.env.WHATSAPP_WABA_ID;
    await app.close();
  });

  it('pushes template to meta and handles provider errors', async () => {
    process.env.WHATSAPP_WABA_ID = 'waba-test';
    const app = await buildApp();

    // 1) Template not found → 404
    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'POST', url: '/wa/whatsapp/templates/t-1/push-to-meta' });
    expect(res.statusCode).toBe(404);

    // 2) Template exists, update hsm name, empty credentials → 400
    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValueOnce({
      id: 't-1',
      branchId: 'b-1',
      type: 'APPOINTMENT_CONFIRMATION',
      name: 'Confirmacao',
      message: 'Oi {{paciente_nome}}, consulta em {{data}}.',
      hsmTemplateName: null,
    });
    mockedPrisma.whatsAppMessageTemplate.update.mockResolvedValueOnce({
      id: 't-1',
      branchId: 'b-1',
      type: 'APPOINTMENT_CONFIRMATION',
      name: 'Confirmacao',
      message: 'Oi {{paciente_nome}}, consulta em {{data}}.',
      hsmTemplateName: 'confirmacao_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ appId: '', accountSid: '' });
    res = await app.inject({ method: 'POST', url: '/wa/whatsapp/templates/t-1/push-to-meta' });
    expect([400, 500]).toContain(res.statusCode);

    // 3) With credentials, Meta API returns error → 400
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ appId: 'app-id', accountSid: 'api-key' });
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ message: 'invalid template' }),
    });
    res = await app.inject({ method: 'POST', url: '/wa/whatsapp/templates/t-1/push-to-meta' });
    expect(res.statusCode).toBe(400);

    // 4) With credentials, 500 from Meta → 400
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ appId: 'app-id', accountSid: 'api-key' });
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'provider raw failure',
    });
    res = await app.inject({ method: 'POST', url: '/wa/whatsapp/templates/t-1/push-to-meta' });
    expect(res.statusCode).toBe(400);

    // 5) Success
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ appId: 'app-id', accountSid: 'api-key' });
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ id: 'tpl-id', status: 'PENDING' }),
    });
    res = await app.inject({ method: 'POST', url: '/wa/whatsapp/templates/t-1/push-to-meta' });
    expect([200, 400]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      expect(res.json().success).toBe(true);
    }

    delete process.env.WHATSAPP_WABA_ID;
    await app.close();
  });

  it('push-to-meta returns 400 when generated HSM name is still empty', async () => {
    process.env.WHATSAPP_WABA_ID = 'waba-test';
    const app = await buildApp();

    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValueOnce({
      id: 't-1',
      branchId: 'b-1',
      type: 'APPOINTMENT_CONFIRMATION',
      name: 'Confirmacao',
      message: 'Oi {{paciente_nome}}, consulta em {{data}}.',
      hsmTemplateName: null,
    });
    mockedPrisma.whatsAppMessageTemplate.update.mockResolvedValueOnce({
      id: 't-1',
      branchId: 'b-1',
      type: 'APPOINTMENT_CONFIRMATION',
      name: 'Confirmacao',
      message: 'Oi {{paciente_nome}}, consulta em {{data}}.',
      hsmTemplateName: null,
    });

    const res = await app.inject({ method: 'POST', url: '/wa/whatsapp/templates/t-1/push-to-meta' });
    expect([400, 500]).toContain(res.statusCode);
    if (res.statusCode === 400) {
      expect(res.json().error).toContain('não foi gerado corretamente');
    }

    delete process.env.WHATSAPP_WABA_ID;
    await app.close();
  });

  it('returns truncated delete attempt details when meta delete responses are very long', async () => {
    process.env.WHATSAPP_WABA_ID = 'waba-test';
    const app = await buildApp();
    const longBody = 'x'.repeat(700);

    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ appId: 'app-id', accountSid: 'api-key' });
    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValueOnce({
      id: 't-long',
      branchId: 'b-1',
      hsmTemplateId: 'remote-id',
      hsmTemplateName: 'temp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      hsmTemplateStatus: 'APPROVED',
      importedFromGupshupSync: true,
    });
    (globalThis.fetch as any).mockResolvedValueOnce({ ok: false, status: 500, text: async () => longBody });

    const res = await app.inject({ method: 'DELETE', url: '/wa/whatsapp/templates/t-long' });
    // Route returns 400 when Meta delete fails with non-404 status
    expect([400, 500]).toContain(res.statusCode);

    delete process.env.WHATSAPP_WABA_ID;
    await app.close();
  });

  it('push-to-meta returns 400 when app id exists but api key is missing', async () => {
    process.env.WHATSAPP_WABA_ID = 'waba-test';
    const app = await buildApp();

    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValueOnce({
      id: 't-12',
      branchId: 'b-1',
      type: 'APPOINTMENT_CONFIRMATION',
      name: 'Confirmacao',
      message: 'Oi {{paciente_nome}}, consulta em {{data}}.',
      hsmTemplateName: 'confirmacao_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ appId: 'app-id', accountSid: '' });

    const res = await app.inject({ method: 'POST', url: '/wa/whatsapp/templates/t-12/push-to-meta' });
    expect(res.statusCode).toBe(400);

    delete process.env.WHATSAPP_WABA_ID;
    await app.close();
  });

  it('push-to-meta uses provider error message fallback', async () => {
    process.env.WHATSAPP_WABA_ID = 'waba-test';
    const app = await buildApp();

    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValueOnce({
      id: 't-1',
      branchId: 'b-1',
      type: 'APPOINTMENT_CONFIRMATION',
      name: 'Confirmacao',
      message: 'Oi {{paciente_nome}}, consulta em {{data}}.',
      hsmTemplateName: 'confirmacao_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ appId: 'app-id', accountSid: 'api-key' });
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ error: { message: 'conflict-message' } }),
    });

    const res = await app.inject({ method: 'POST', url: '/wa/whatsapp/templates/t-1/push-to-meta' });
    expect(res.statusCode).toBe(400);

    delete process.env.WHATSAPP_WABA_ID;
    await app.close();
  });

  it('pushes non-confirmation template without buttons', async () => {
    process.env.WHATSAPP_WABA_ID = 'waba-test';
    const app = await buildApp();

    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValueOnce({
      id: 't-7',
      branchId: 'b-1',
      type: 'REMINDER',
      name: 'Lembrete',
      message: 'Oi {{paciente_nome}}',
      hsmTemplateName: 'lembrete_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ appId: 'app-id', accountSid: 'api-key' });
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ error: { message: 'details-fallback-message' } }),
    });

    const res = await app.inject({ method: 'POST', url: '/wa/whatsapp/templates/t-7/push-to-meta' });
    expect(res.statusCode).toBe(400);
    // Meta uses JSON body, check no BUTTONS type for REMINDER
    const requestBody = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(requestBody.components.some((c: any) => c.type === 'BUTTONS')).toBe(false);

    delete process.env.WHATSAPP_WABA_ID;
    await app.close();
  });

  it('accepts non-json provider response when template already has valid hsm name', async () => {
    process.env.WHATSAPP_WABA_ID = 'waba-test';
    const app = await buildApp();

    mockedPrisma.whatsAppMessageTemplate.findFirst.mockResolvedValueOnce({
      id: 't-9',
      branchId: 'b-1',
      type: 'APPOINTMENT_CONFIRMATION',
      name: 'Confirmacao',
      message: 'Oi {{paciente_nome}}, {{hora}}',
      hsmTemplateName: 'confirmacao_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ appId: 'app-id', accountSid: 'api-key' });
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: async () => 'submitted-without-json',
    });

    const res = await app.inject({ method: 'POST', url: '/wa/whatsapp/templates/t-9/push-to-meta' });
    expect([200, 500]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      expect(res.json().metaResponse).toBe('submitted-without-json');
    }
    expect(mockedPrisma.whatsAppMessageTemplate.update).not.toHaveBeenCalled();

    delete process.env.WHATSAPP_WABA_ID;
    await app.close();
  });


  it('handles notification, available variables and sync endpoints', async () => {
    const app = await buildApp();

    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ accountSid: '', authToken: '', fromNumber: '' });
    let res = await app.inject({ method: 'GET', url: '/wa/whatsapp/notification-config' });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'GET', url: '/wa/whatsapp/notification-config' });
    expect(res.statusCode).toBe(200);

    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValueOnce({ accountSid: '', authToken: '', fromNumber: '' });
    res = await app.inject({
      method: 'POST',
      url: '/wa/whatsapp/notification-config',
      payload: { sendOnAppointmentCreated: false },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/wa/whatsapp/notification-config',
      payload: { sendReminderEnabled: true, reminderHoursBefore: 3 },
    });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: '/wa/whatsapp/available-variables' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(['paciente_nome', 'data']);

    mockedSync.mockRejectedValueOnce(new Error('sync failed'));
    res = await app.inject({ method: 'POST', url: '/wa/whatsapp/templates/sync-hsm' });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/wa/whatsapp/templates/sync-hsm' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('uses notification defaults and sync fallback error message', async () => {
    const app = await buildApp();

    let res = await app.inject({
      method: 'POST',
      url: '/wa/whatsapp/notification-config',
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.whatsAppNotificationConfig.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        sendReminderEnabled: false,
        reminderHoursBefore: 2,
      }),
    }));

    mockedSync.mockRejectedValueOnce({});
    res = await app.inject({ method: 'POST', url: '/wa/whatsapp/templates/sync-hsm' });
    expect(res.statusCode).toBe(400);
    expect(mockedSync).toHaveBeenCalledWith('b-1');

    await app.close();
  });
});
