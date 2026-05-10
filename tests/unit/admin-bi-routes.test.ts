import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/modules/admin/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    appointment: { findMany: vi.fn(), count: vi.fn() },
    preSchedulingFlow: { count: vi.fn() },
    preAttendance: { count: vi.fn() },
    consultation: { count: vi.fn() },
    report: { findMany: vi.fn() },
    reportWorklistItem: { count: vi.fn() },
    financeEntry: { findMany: vi.fn() },
    invoice: { findMany: vi.fn() },
    tissBatch: { findMany: vi.fn() },
    inventoryItem: { findMany: vi.fn() },
    teaProfile: { count: vi.fn() },
    teaPreReservation: { count: vi.fn(), findMany: vi.fn() },
    sector: { findMany: vi.fn() },
    medicalEquipment: { findMany: vi.fn() },
    doctor: { findMany: vi.fn() },
    whatsAppConversation: { findMany: vi.fn() },
    whatsAppMessageLog: { findMany: vi.fn() },
    delivery: { findMany: vi.fn() },
    biInsightCache: { findUnique: vi.fn(), upsert: vi.fn() },
    inventoryMovement: { findMany: vi.fn() },
  },
}));

import prismaModule from '../../src/modules/admin/lib/prisma';
const prisma = prismaModule as any;

const COMPANY_USER = {
  id: 'u-1',
  isAdmHubOnly: false,
  sector: { branch: { id: 'b-1', companyId: 'c-1', company: { id: 'c-1' } } },
  accesses: [{ modules: [{ name: 'bi-gestao' }] }],
};

const NO_COMPANY_USER = {
  id: 'u-2',
  isAdmHubOnly: false,
  sector: null,
  accesses: [],
};

const NO_BI_USER = {
  id: 'u-3',
  isAdmHubOnly: false,
  sector: { branch: { id: 'b-1', companyId: 'c-1', company: { id: 'c-1' } } },
  accesses: [],
};

async function buildApp(userFixture = COMPANY_USER) {
  const { default: biRoutes } = await import('../../src/modules/admin/routes/bi');
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function (this: any) {
    this.user = { id: userFixture.id };
  });
  await app.register(biRoutes, { prefix: '/bi' });
  return app;
}

function mockEmptyOverview() {
  prisma.appointment.findMany.mockResolvedValue([]);
  prisma.appointment.count.mockResolvedValue(0);
  prisma.preSchedulingFlow.count.mockResolvedValue(0);
  prisma.preAttendance.count.mockResolvedValue(0);
  prisma.consultation.count.mockResolvedValue(0);
  prisma.report.findMany.mockResolvedValue([]);
  prisma.reportWorklistItem.count.mockResolvedValue(0);
  prisma.financeEntry.findMany.mockResolvedValue([]);
  prisma.invoice.findMany.mockResolvedValue([]);
  prisma.tissBatch.findMany.mockResolvedValue([]);
  prisma.inventoryItem.findMany.mockResolvedValue([]);
  prisma.teaProfile.count.mockResolvedValue(0);
  prisma.teaPreReservation.count.mockResolvedValue(0);
  prisma.teaPreReservation.findMany.mockResolvedValue([]);
  prisma.sector.findMany.mockResolvedValue([]);
  prisma.medicalEquipment.findMany.mockResolvedValue([]);
  prisma.doctor.findMany.mockResolvedValue([]);
  prisma.whatsAppConversation.findMany.mockResolvedValue([]);
  prisma.whatsAppMessageLog.findMany.mockResolvedValue([]);
  prisma.delivery.findMany.mockResolvedValue([]);
  prisma.inventoryMovement.findMany.mockResolvedValue([]);
}

describe('admin bi routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // ── auth guards ─────────────────────────────────────────────────────────────

  it('returns 403 when user has no company', async () => {
    prisma.user.findUnique.mockResolvedValue(NO_COMPANY_USER);
    const app = await buildApp(NO_COMPANY_USER);
    const res = await app.inject({ method: 'GET', url: '/bi/overview' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('returns 403 when user has no BI access', async () => {
    prisma.user.findUnique.mockResolvedValue(NO_BI_USER);
    const app = await buildApp(NO_BI_USER);
    const res = await app.inject({ method: 'GET', url: '/bi/overview' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('allows access when isAdmHubOnly is true even without bi-gestao module', async () => {
    const adminUser = { ...NO_BI_USER, isAdmHubOnly: true };
    prisma.user.findUnique.mockResolvedValue({
      ...adminUser,
      sector: { branch: { id: 'b-1', companyId: 'c-1', company: { id: 'c-1' } } },
    });
    mockEmptyOverview();
    const app = await buildApp({ ...adminUser, id: 'u-3', sector: { branch: { id: 'b-1', companyId: 'c-1', company: { id: 'c-1' } } } } as any);
    const res = await app.inject({ method: 'GET', url: '/bi/overview' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  // ── /overview ───────────────────────────────────────────────────────────────

  it('returns overview with kpis, charts, alerts', async () => {
    prisma.user.findUnique.mockResolvedValue(COMPANY_USER);
    prisma.appointment.findMany.mockResolvedValue([
      { id: 'a1', date: '2024-01-01', status: 'Atendido', specialty: 'Cardiologia', type: null, convenio: 'Unimed' },
      { id: 'a2', date: '2024-01-01', status: 'Cancelado', specialty: 'Ortopedia', type: null, convenio: null },
      { id: 'a3', date: '2024-01-01', status: 'Agendado', specialty: null, type: 'Consulta', convenio: 'Particular' },
    ]);
    prisma.appointment.count.mockResolvedValue(0);
    prisma.preSchedulingFlow.count.mockResolvedValue(5);
    prisma.preAttendance.count.mockResolvedValue(3);
    prisma.consultation.count.mockResolvedValue(1);
    prisma.report.findMany.mockResolvedValue([
      { id: 'r1', status: 'Assinado', issuerSignedAt: new Date(), reviewerSignedAt: null, createdAt: new Date() },
    ]);
    prisma.reportWorklistItem.count.mockResolvedValue(2);
    prisma.financeEntry.findMany.mockResolvedValue([
      { id: 'f1', type: 'RECEITA', category: null, value: 1000, total: 1000, status: 'paid', dueDate: new Date(), createdAt: new Date() },
      { id: 'f2', type: 'DESPESA', category: null, value: 500, total: 500, status: 'paid', dueDate: new Date(), createdAt: new Date() },
    ]);
    prisma.invoice.findMany.mockResolvedValue([
      { id: 'i1', status: 'paid', convention: 'Unimed', total: 800, value: 800, issuedAt: new Date() },
    ]);
    prisma.tissBatch.findMany.mockResolvedValue([
      { id: 't1', status: 'SENT', items: [{ glosaValue: 100, returnStatus: null, status: 'ok' }] },
    ]);
    prisma.inventoryItem.findMany.mockResolvedValue([
      { id: 'inv1', quantity: 0, minQuantity: 5, status: 'low', unitPrice: 10 },
    ]);
    prisma.teaProfile.count.mockResolvedValue(4);
    prisma.teaPreReservation.count.mockResolvedValue(2);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/bi/overview' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('kpis');
    expect(body).toHaveProperty('charts');
    expect(body).toHaveProperty('alerts');
    expect(body.kpis.realizedAppointments).toBe(1);
    expect(body.kpis.canceledAppointments).toBe(1);
    expect(body.kpis.revenue).toBe(1000);
    expect(body.kpis.expenses).toBe(500);
    expect(body.kpis.invoiced).toBe(800);
    expect(body.kpis.criticalStock).toBe(1);
    expect(body.kpis.pendingTiss).toBe(1);
    expect(body.kpis.glosaValue).toBe(100);
    await app.close();
  });

  it('overview accepts date filters', async () => {
    prisma.user.findUnique.mockResolvedValue(COMPANY_USER);
    mockEmptyOverview();
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/bi/overview?startDate=2024-01-01&endDate=2024-01-31' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.filters.startDate).toBe('2024-01-01');
    expect(body.filters.endDate).toBe('2024-01-31');
    await app.close();
  });

  // ── /occupancy ──────────────────────────────────────────────────────────────

  it('occupancy auth guard works', async () => {
    prisma.user.findUnique.mockResolvedValue(NO_COMPANY_USER);
    const app = await buildApp(NO_COMPANY_USER);
    const res = await app.inject({ method: 'GET', url: '/bi/occupancy' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('occupancy returns 200 with empty data', async () => {
    prisma.user.findUnique.mockResolvedValue(COMPANY_USER);
    prisma.appointment.findMany.mockResolvedValue([]);
    prisma.sector.findMany.mockResolvedValue([]);
    prisma.medicalEquipment.findMany.mockResolvedValue([]);
    prisma.doctor.findMany.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/bi/occupancy' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  // ── /financial ──────────────────────────────────────────────────────────────

  it('financial auth guard works', async () => {
    prisma.user.findUnique.mockResolvedValue(NO_BI_USER);
    const app = await buildApp(NO_BI_USER);
    const res = await app.inject({ method: 'GET', url: '/bi/financial' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('financial returns 200 with empty data', async () => {
    prisma.user.findUnique.mockResolvedValue(COMPANY_USER);
    prisma.financeEntry.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.tissBatch.findMany.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/bi/financial' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  // ── /clinical ───────────────────────────────────────────────────────────────

  it('clinical returns 200 with empty data', async () => {
    prisma.user.findUnique.mockResolvedValue(COMPANY_USER);
    prisma.appointment.findMany.mockResolvedValue([]);
    prisma.report.findMany.mockResolvedValue([]);
    prisma.consultation.count.mockResolvedValue(0);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/bi/clinical' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  // ── /resources ──────────────────────────────────────────────────────────────

  it('resources returns 200 with empty data', async () => {
    prisma.user.findUnique.mockResolvedValue(COMPANY_USER);
    prisma.inventoryItem.findMany.mockResolvedValue([]);
    prisma.inventoryMovement.findMany.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/bi/resources' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  // ── /authorizations ─────────────────────────────────────────────────────────

  it('authorizations returns 200 with empty data', async () => {
    prisma.user.findUnique.mockResolvedValue(COMPANY_USER);
    prisma.appointment.findMany.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/bi/authorizations' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  // ── /tea ────────────────────────────────────────────────────────────────────

  it('tea returns 200 with empty data', async () => {
    prisma.user.findUnique.mockResolvedValue(COMPANY_USER);
    prisma.teaProfile.count.mockResolvedValue(0);
    prisma.teaPreReservation.count.mockResolvedValue(0);
    prisma.teaPreReservation.findMany.mockResolvedValue([]);
    prisma.appointment.findMany.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/bi/tea' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  // ── /reports ────────────────────────────────────────────────────────────────

  it('reports returns 200 with empty data', async () => {
    prisma.user.findUnique.mockResolvedValue(COMPANY_USER);
    prisma.report.findMany.mockResolvedValue([]);
    prisma.reportWorklistItem.count.mockResolvedValue(0);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/bi/reports' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  // ── /communication ──────────────────────────────────────────────────────────

  it('communication returns 200 with empty data', async () => {
    prisma.user.findUnique.mockResolvedValue(COMPANY_USER);
    prisma.whatsAppConversation.findMany.mockResolvedValue([]);
    prisma.whatsAppMessageLog.findMany.mockResolvedValue([]);
    prisma.delivery.findMany.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/bi/communication' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  // ── /appointments ───────────────────────────────────────────────────────────

  it('appointments returns 200 with empty data', async () => {
    prisma.user.findUnique.mockResolvedValue(COMPANY_USER);
    prisma.appointment.findMany.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/bi/appointments' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  // ── /inventory ──────────────────────────────────────────────────────────────

  it('inventory returns 200 with empty data', async () => {
    prisma.user.findUnique.mockResolvedValue(COMPANY_USER);
    prisma.inventoryItem.findMany.mockResolvedValue([]);
    prisma.inventoryMovement.findMany.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/bi/inventory' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  // ── /insights ───────────────────────────────────────────────────────────────

  it('insights returns 403 when user has no company', async () => {
    prisma.user.findUnique.mockResolvedValue(NO_COMPANY_USER);
    const app = await buildApp(NO_COMPANY_USER);
    const res = await app.inject({ method: 'POST', url: '/bi/insights', payload: { data: {} } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('insights returns cached result when cache is fresh', async () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    prisma.user.findUnique.mockResolvedValue(COMPANY_USER);
    prisma.biInsightCache.findUnique.mockResolvedValue({
      summary: 'cached summary',
      positives: ['pos1'],
      negatives: ['neg1'],
      alerts: [],
      suggestions: [],
      generatedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/bi/insights',
      payload: { data: { kpis: {} }, period: { startDate: '2024-01-01', endDate: '2024-01-31' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().fromCache).toBe(true);
    expect(res.json().summary).toBe('cached summary');
    await app.close();
  });

  it('insights calls groq and stores result when cache is expired', async () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    prisma.user.findUnique.mockResolvedValue(COMPANY_USER);
    prisma.biInsightCache.findUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() - 1000),
    });
    prisma.biInsightCache.upsert.mockResolvedValue({});

    const groqResponse = {
      summary: 'AI summary',
      positives: ['good metric'],
      negatives: ['bad metric'],
      alerts: [{ text: 'alert', priority: 'ALTO' }],
      suggestions: [{ text: 'do this', timeframe: 'imediato', owner: 'gestão' }],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(groqResponse) } }] }),
    }));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/bi/insights',
      payload: { data: { kpis: {} } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().fromCache).toBe(false);
    expect(res.json().summary).toBe('AI summary');
    expect(prisma.biInsightCache.upsert).toHaveBeenCalled();
    await app.close();
  });

  it('insights bypasses cache when force=true', async () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    prisma.user.findUnique.mockResolvedValue(COMPANY_USER);
    prisma.biInsightCache.upsert.mockResolvedValue({});

    const groqResponse = { summary: 'fresh', positives: [], negatives: [], alerts: [], suggestions: [] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(groqResponse) } }] }),
    }));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/bi/insights',
      payload: { data: {}, force: true },
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.biInsightCache.findUnique).not.toHaveBeenCalled();
    await app.close();
  });

  it('insights returns 502 when groq responds not ok', async () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    prisma.user.findUnique.mockResolvedValue(COMPANY_USER);
    prisma.biInsightCache.findUnique.mockResolvedValue(null);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: 'groq error' } }),
    }));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/bi/insights',
      payload: { data: {} },
    });
    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it('insights returns 502 when groq response is invalid JSON', async () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    prisma.user.findUnique.mockResolvedValue(COMPANY_USER);
    prisma.biInsightCache.findUnique.mockResolvedValue(null);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'not-json' } }] }),
    }));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/bi/insights',
      payload: { data: {} },
    });
    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it('insights returns 502 when fetch throws', async () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    prisma.user.findUnique.mockResolvedValue(COMPANY_USER);
    prisma.biInsightCache.findUnique.mockResolvedValue(null);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/bi/insights',
      payload: { data: {} },
    });
    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it('insights normalizes string alerts and suggestions from groq', async () => {
    vi.stubEnv('GROQ_API_KEY', 'test-key');
    prisma.user.findUnique.mockResolvedValue(COMPANY_USER);
    prisma.biInsightCache.findUnique.mockResolvedValue(null);
    prisma.biInsightCache.upsert.mockResolvedValue({});

    const groqResponse = {
      summary: 'test',
      positives: ['pos'],
      negatives: ['neg'],
      alerts: ['plain string alert'],
      suggestions: ['plain string suggestion'],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(groqResponse) } }] }),
    }));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/bi/insights',
      payload: { data: {} },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().alerts[0]).toEqual({ text: 'plain string alert', priority: 'MÉDIO' });
    expect(res.json().suggestions[0]).toMatchObject({ text: 'plain string suggestion', timeframe: 'esta semana' });
    await app.close();
  });
});
