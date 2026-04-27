import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import tissBatchRoutes from '../../src/modules/admin/routes/tiss-batches';
import prisma from '../../src/modules/admin/lib/prisma';

vi.mock('../../src/modules/admin/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    insurance: { findFirst: vi.fn() },
    invoice: { findMany: vi.fn() },
    tissBatch: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    tissBatchItem: {
      findFirst: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

const mockedPrisma = prisma as any;

async function buildApp(opts?: { jwtFails?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.jwtFails) throw new Error('nope');
    this.user = { id: 'u-1' };
  });

  app.addSchema({ $id: 'TissBatchCreate', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'TissBatch', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'TissBatchProtocolUpdate', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'TissBatchReturnCreate', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'TissBatchReprocessCreate', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'TissBatchStatusUpdate', type: 'object', additionalProperties: true });

  await app.register(tissBatchRoutes, { prefix: '/tiss-batches' });
  return app;
}

function validInvoice(overrides?: Record<string, any>) {
  return {
    id: 'inv-1',
    number: 'FAT-001',
    convention: 'Unimed',
    total: 100,
    packageValue: 0,
    materialsValue: 0,
    feesValue: 0,
    dailyValue: 0,
    gasesValue: 0,
    opmeValue: 0,
    discount: 0,
    expectedDiscountValue: 0,
    expectedGlosaValue: 0,
    procedureItems: [{ totalValue: 100, quantity: 1, unitValue: 100, procedureName: 'PROC' }],
    ...overrides,
  };
}

describe('admin tiss batches routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b-1' } } });
  });

  it('returns 401 when jwt verification fails', async () => {
    const app = await buildApp({ jwtFails: true });
    const res = await app.inject({ method: 'GET', url: '/tiss-batches' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('lists batches and handles branch association', async () => {
    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    mockedPrisma.tissBatch.findMany.mockResolvedValue([
      {
        id: 'tb-1',
        items: [{ invoice: { total: 80 } }, { invoice: { total: 20 } }],
      },
    ]);
    mockedPrisma.tissBatch.count.mockResolvedValue(1);

    const app = await buildApp();

    const forbidden = await app.inject({ method: 'GET', url: '/tiss-batches' });
    expect(forbidden.statusCode).toBe(403);

    const ok = await app.inject({ method: 'GET', url: '/tiss-batches?status=SENT&search=LOT&limit=10&offset=0' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().items[0].invoicesCount).toBe(2);
    expect(ok.json().items[0].totalValue).toBe(100);

    await app.close();
  });

  it('gets batch by id and 404 when missing', async () => {
    mockedPrisma.tissBatch.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'tb-1', isActive: true, items: [] });

    const app = await buildApp();

    const missing = await app.inject({ method: 'GET', url: '/tiss-batches/tb-1' });
    expect(missing.statusCode).toBe(404);

    const ok = await app.inject({ method: 'GET', url: '/tiss-batches/tb-1' });
    expect(ok.statusCode).toBe(200);

    await app.close();
  });

  it('validates create payload and creates batch with collision retry', async () => {
    mockedPrisma.invoice.findMany.mockResolvedValue([validInvoice()]);
    mockedPrisma.tissBatchItem.findFirst.mockResolvedValue(null);

    const tx = {
      tissBatch: {
        create: vi.fn().mockRejectedValueOnce({ code: 'P2002' }).mockResolvedValueOnce({ id: 'tb-1', batchNumber: 'TISS-1' }),
        findUnique: vi.fn().mockResolvedValue({ id: 'tb-1', isActive: true, items: [] }),
      },
      tissBatchItem: { createMany: vi.fn() },
    };
    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const app = await buildApp();

    let res = await app.inject({
      method: 'POST',
      url: '/tiss-batches',
      payload: { competenceMonth: '2026-13', convention: 'Unimed', invoiceIds: ['inv-1'] },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/tiss-batches',
      payload: { competenceMonth: '2026-04', convention: '', invoiceIds: ['inv-1'] },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/tiss-batches',
      payload: { competenceMonth: '2026-04', convention: 'Unimed', invoiceIds: [] },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/tiss-batches',
      payload: { competenceMonth: '2026-04', convention: 'Unimed', invoiceIds: ['inv-1'] },
    });
    expect(res.statusCode).toBe(201);
    expect(tx.tissBatch.create).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it('returns 400 on lot-level financial divergence even when guides are individually valid', async () => {
    mockedPrisma.invoice.findMany.mockResolvedValue([
      validInvoice({ id: 'inv-1', number: 'FAT-001', total: 100.014, procedureItems: [{ totalValue: 100.01, quantity: 1, unitValue: 100.01, procedureName: 'PROC-1' }] }),
      validInvoice({ id: 'inv-2', number: 'FAT-002', total: 100.014, procedureItems: [{ totalValue: 100.01, quantity: 1, unitValue: 100.01, procedureName: 'PROC-2' }] }),
      validInvoice({ id: 'inv-3', number: 'FAT-003', total: 100.014, procedureItems: [{ totalValue: 100.01, quantity: 1, unitValue: 100.01, procedureName: 'PROC-3' }] }),
      validInvoice({ id: 'inv-4', number: 'FAT-004', total: 100.014, procedureItems: [{ totalValue: 100.01, quantity: 1, unitValue: 100.01, procedureName: 'PROC-4' }] }),
    ]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/tiss-batches',
      payload: { competenceMonth: '2026-04', convention: 'Unimed', invoiceIds: ['inv-1', 'inv-2', 'inv-3', 'inv-4'] },
    });

    expect(res.statusCode).toBe(400);
    expect(String(res.json().error || '')).toContain('Conferencia do lote divergente');
    await app.close();
  });

  it('returns 500 when create transaction throws non-P2002 error', async () => {
    mockedPrisma.invoice.findMany.mockResolvedValue([validInvoice()]);
    mockedPrisma.tissBatchItem.findFirst.mockResolvedValue(null);

    const tx = {
      tissBatch: {
        create: vi.fn().mockRejectedValue({ code: 'ERR_UNEXPECTED' }),
        findUnique: vi.fn(),
      },
      tissBatchItem: { createMany: vi.fn() },
    };
    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/tiss-batches',
      payload: { competenceMonth: '2026-04', convention: 'Unimed', invoiceIds: ['inv-1'] },
    });

    expect(res.statusCode).toBe(500);
    await app.close();
  });

  it('blocks create when invoice is in another active batch', async () => {
    mockedPrisma.invoice.findMany.mockResolvedValue([validInvoice()]);
    mockedPrisma.tissBatchItem.findFirst.mockResolvedValue({
      invoiceId: 'inv-1',
      invoice: { number: 'FAT-001' },
      batch: { isActive: true, batchNumber: 'TISS-OLD' },
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/tiss-batches',
      payload: { competenceMonth: '2026-04', convention: 'Unimed', invoiceIds: ['inv-1'] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('already in active batch');

    await app.close();
  });

  it('updates protocol and status', async () => {
    mockedPrisma.tissBatch.findUnique.mockResolvedValue({ id: 'tb-1', isActive: true, sentAt: null });
    mockedPrisma.tissBatch.update.mockResolvedValue({ id: 'tb-1', status: 'SENT' });

    const app = await buildApp();

    let res = await app.inject({ method: 'PATCH', url: '/tiss-batches/tb-1/protocol', payload: { protocolNumber: '' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.tissBatch.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'PATCH', url: '/tiss-batches/tb-1/protocol', payload: { protocolNumber: 'P-1' } });
    expect(res.statusCode).toBe(404);

    mockedPrisma.tissBatch.findUnique.mockResolvedValueOnce({ id: 'tb-1', isActive: true, sentAt: null });
    res = await app.inject({ method: 'PATCH', url: '/tiss-batches/tb-1/protocol', payload: { protocolNumber: 'P-1' } });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'PATCH', url: '/tiss-batches/tb-1/status', payload: { status: 'bad' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.tissBatch.update.mockResolvedValueOnce({ id: 'tb-1', status: 'SENT' });
    res = await app.inject({ method: 'PATCH', url: '/tiss-batches/tb-1/status', payload: { status: 'SENT', protocolNumber: 'PX' } });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('registers return entries and resolves batch status', async () => {
    mockedPrisma.tissBatch.findUnique.mockResolvedValue({
      id: 'tb-1',
      isActive: true,
      sentAt: null,
      items: [{ id: 'it-1', guideNumber: 'GUIA-1', invoice: { procedureItems: [] } }],
    });

    const tx = {
      tissBatchItem: { update: vi.fn() },
      tissBatch: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'tb-1',
          sentAt: null,
          items: [{ id: 'it-1', returnStatus: 'ACCEPTED', isActive: true, invoice: {} }],
        }),
        update: vi.fn().mockResolvedValue({ id: 'tb-1', status: 'ACCEPTED' }),
      },
    };
    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/tiss-batches/tb-1/return', payload: { items: [] } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/tiss-batches/tb-1/return',
      payload: { items: [{ guideNumber: 'GUIA-1', status: 'ACCEPTED', glosaValue: 1 }] },
    });
    expect(res.statusCode).toBe(200);
    expect(tx.tissBatchItem.update).toHaveBeenCalled();

    await app.close();
  });

  it('re-presents rejected guides and validates edge cases', async () => {
    mockedPrisma.tissBatch.findUnique.mockResolvedValue({
      id: 'tb-1',
      isActive: true,
      competenceMonth: '2026-04',
      convention: 'Unimed',
      items: [
        { id: 'it-1', invoiceId: 'inv-1', returnStatus: 'REJECTED', isRepresented: false, invoice: { number: 'FAT-001' } },
      ],
    });
    mockedPrisma.tissBatchItem.findFirst.mockResolvedValue(null);

    const tx = {
      tissBatchItem: { updateMany: vi.fn(), createMany: vi.fn() },
      tissBatch: {
        create: vi.fn().mockResolvedValue({ id: 'tb-2' }),
        findUnique: vi.fn().mockResolvedValue({ id: 'tb-2', items: [] }),
      },
    };
    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/tiss-batches/tb-1/represent', payload: { itemIds: ['x'], competenceMonth: '2026-04' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.tissBatch.findUnique.mockResolvedValueOnce({
      id: 'tb-1',
      isActive: true,
      competenceMonth: '2026-04',
      convention: 'Unimed',
      items: [{ id: 'it-1', invoiceId: 'inv-1', returnStatus: 'REJECTED', isRepresented: false, invoice: { number: 'FAT-001' } }],
    });
    res = await app.inject({ method: 'POST', url: '/tiss-batches/tb-1/represent', payload: { competenceMonth: '2026-13' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.tissBatch.findUnique.mockResolvedValueOnce({
      id: 'tb-1',
      isActive: true,
      competenceMonth: '2026-04',
      convention: 'Unimed',
      items: [{ id: 'it-1', invoiceId: 'inv-1', returnStatus: 'REJECTED', isRepresented: false, invoice: { number: 'FAT-001' } }],
    });
    res = await app.inject({ method: 'POST', url: '/tiss-batches/tb-1/represent', payload: { competenceMonth: '2026-04' } });
    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it('blocks re-presentation when invoice already belongs to another active batch', async () => {
    mockedPrisma.tissBatch.findUnique.mockResolvedValue({
      id: 'tb-1',
      isActive: true,
      competenceMonth: '2026-04',
      convention: 'Unimed',
      items: [
        { id: 'it-1', invoiceId: 'inv-1', returnStatus: 'REJECTED', isRepresented: false, invoice: { number: 'FAT-001' } },
      ],
    });
    mockedPrisma.tissBatchItem.findFirst.mockResolvedValue({
      invoiceId: 'inv-1',
      invoice: { number: 'FAT-001' },
      batch: { batchNumber: 'TISS-EXISTENTE' },
    });

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/tiss-batches/tb-1/represent', payload: { competenceMonth: '2026-04' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('already belongs to active batch');
    await app.close();
  });

  it('returns 500 on re-presentation batch creation unexpected error (non-P2002)', async () => {
    mockedPrisma.tissBatch.findUnique.mockResolvedValue({
      id: 'tb-1',
      isActive: true,
      competenceMonth: '2026-04',
      convention: 'Unimed',
      items: [
        { id: 'it-1', invoiceId: 'inv-1', returnStatus: 'REJECTED', isRepresented: false, invoice: { number: 'FAT-001' } },
      ],
    });
    mockedPrisma.tissBatchItem.findFirst.mockResolvedValue(null);

    const tx = {
      tissBatchItem: { updateMany: vi.fn(), createMany: vi.fn() },
      tissBatch: {
        create: vi.fn().mockRejectedValue({ code: 'ERR_OTHER' }),
        findUnique: vi.fn(),
      },
    };
    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/tiss-batches/tb-1/represent', payload: { competenceMonth: '2026-04' } });
    expect(res.statusCode).toBe(500);
    await app.close();
  });

  it('validates guide reference on return registration and retries represent batch creation on P2002', async () => {
    mockedPrisma.tissBatch.findUnique
      .mockResolvedValueOnce({
        id: 'tb-1',
        isActive: true,
        sentAt: null,
        items: [{ id: 'it-1', guideNumber: 'GUIA-1', invoice: {} }],
      })
      .mockResolvedValueOnce({
        id: 'tb-2',
        isActive: true,
        competenceMonth: '2026-04',
        convention: 'Unimed',
        items: [{ id: 'it-2', invoiceId: 'inv-2', returnStatus: 'REJECTED', isRepresented: false, invoice: { number: 'FAT-002' } }],
      });

    const txRepresent = {
      tissBatchItem: { updateMany: vi.fn(), createMany: vi.fn() },
      tissBatch: {
        create: vi.fn().mockRejectedValueOnce({ code: 'P2002' }).mockResolvedValueOnce({ id: 'tb-3' }),
        findUnique: vi.fn().mockResolvedValue({ id: 'tb-3', items: [] }),
      },
    };
    mockedPrisma.$transaction.mockImplementationOnce(async (cb: any) => cb(txRepresent));

    mockedPrisma.tissBatchItem.findFirst.mockResolvedValue(null);

    const app = await buildApp();

    let res = await app.inject({
      method: 'POST',
      url: '/tiss-batches/tb-1/return',
      payload: { items: [{ guideNumber: 'GUIA-NAO-EXISTE', status: 'ACCEPTED' }] },
    });
    expect(res.statusCode).toBe(500);

    res = await app.inject({ method: 'POST', url: '/tiss-batches/tb-2/represent', payload: { competenceMonth: '2026-04' } });
    expect(res.statusCode).toBe(201);
    expect(txRepresent.tissBatch.create).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it('generates tiss xml and handles missing config', async () => {
    const batch = {
      id: 'tb-1',
      isActive: true,
      status: 'DRAFT',
      batchNumber: 'TISS-202604-1234',
      competenceMonth: '2026-04',
      convention: 'Unimed',
      items: [
        {
          id: 'it-1',
          guideNumber: 'GUIA-1',
          invoice: validInvoice({
            guideType: 'CONSULTA',
            patientName: 'Paciente 1',
            beneficiaryCardNumber: '123',
            authorizationPassword: 'abc',
            operatorGuideNumber: 'og-1',
            authorizationDate: '2026-04-01',
            authorizationExpiryDate: '2026-04-30',
            requestingProfessionalName: 'Dr A',
            requestingProfessionalCpf: '12345678900',
            procedureItems: [{ procedureName: 'Consulta', quantity: 1, unitValue: 100, totalValue: 100, tableCode: '22', tussCode: '10101012' }],
          }),
        },
        {
          id: 'it-2',
          guideNumber: 'GUIA-2',
          invoice: validInvoice({
            number: 'FAT-002',
            guideType: 'SP_SADT',
            requestingProfessionalName: 'Dr B',
            requestingProfessionalCpf: '98765432100',
            procedureItems: [{ procedureName: 'Exame', quantity: 1, unitValue: 100, totalValue: 100, tableCode: '22', tussCode: '20101010' }],
          }),
        },
      ],
    };

    mockedPrisma.tissBatch.findUnique.mockResolvedValue(batch);
    mockedPrisma.tissBatch.update.mockResolvedValue({ id: 'tb-1' });

    const app = await buildApp();

    mockedPrisma.insurance.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'GET', url: '/tiss-batches/tb-1/xml' });
    expect(res.statusCode).toBe(400);

    mockedPrisma.tissBatch.findUnique.mockResolvedValueOnce(batch);
    mockedPrisma.insurance.findFirst.mockResolvedValueOnce({
      tissRegistroAns: '123456',
      tissOperadoraCnpj: '12345678000195',
      tissVersao: '3.05.00',
      tissPrestadorCnpj: '10987654000199',
      tissPrestadorCnes: '1234567',
      tissCodigoPrestadorOperadora: 'COD123',
    });

    res = await app.inject({ method: 'GET', url: '/tiss-batches/tb-1/xml' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.body).toContain('<ans:mensagemTISS');
    expect(res.body).toContain('<guiaConsulta>');
    expect(res.body).toContain('<guiaSP-SADT>');

    await app.close();
  });

  it('validates invoice batch creation edge cases', async () => {
    const app = await buildApp();

    // invoice not found
    mockedPrisma.invoice.findMany.mockResolvedValueOnce([]);
    let res = await app.inject({
      method: 'POST',
      url: '/tiss-batches',
      payload: { competenceMonth: '2026-04', convention: 'Unimed', invoiceIds: ['not-exist'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not found/i);

    // convention mismatch
    mockedPrisma.invoice.findMany.mockResolvedValueOnce([validInvoice({ convention: 'Bradesco' })]);
    mockedPrisma.tissBatchItem.findFirst.mockResolvedValue(null);
    res = await app.inject({
      method: 'POST',
      url: '/tiss-batches',
      payload: { competenceMonth: '2026-04', convention: 'Unimed', invoiceIds: ['inv-1'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/does not match convention/i);

    // guide totals divergence (total != sum of procedureItems)
    mockedPrisma.invoice.findMany.mockResolvedValueOnce([validInvoice({
      total: 999,
      procedureItems: [{ totalValue: 50, quantity: 1, unitValue: 50, procedureName: 'PROC' }],
    })]);
    mockedPrisma.tissBatchItem.findFirst.mockResolvedValue(null);
    res = await app.inject({
      method: 'POST',
      url: '/tiss-batches',
      payload: { competenceMonth: '2026-04', convention: 'Unimed', invoiceIds: ['inv-1'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/divergente/i);

    await app.close();
  });


  it('covers invoiceIds non-array branch and xml procedure zero-value paths', async () => {
    const app = await buildApp();

    // invoiceIds not an array (null) → Array.isArray false → normalized to [] → 400
    const res = await app.inject({
      method: 'POST',
      url: '/tiss-batches',
      payload: { competenceMonth: '2026-04', convention: 'Unimed', invoiceIds: null },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/at least one invoice/i);

    // xml: procedure with zero unitValue/totalValue → covers lines 258,261
    mockedPrisma.tissBatch.findUnique.mockResolvedValueOnce({
      id: 'tb-1', isActive: true, status: 'DRAFT', batchNumber: 'TISS-202604-9999',
      competenceMonth: '2026-04', convention: 'Unimed',
      items: [{
        id: 'it-1', guideNumber: 'GUIA-Z',
        invoice: validInvoice({
          guideType: 'CONSULTA', total: 0,
          patientName: 'P', beneficiaryCardNumber: '1', authorizationPassword: 'x',
          operatorGuideNumber: 'o', authorizationDate: '2026-04-01',
          requestingProfessionalName: 'Dr Z', requestingProfessionalCpf: '00000000000',
          procedureItems: [{ procedureName: 'PROC', quantity: 1, unitValue: 0, totalValue: 0, tableCode: '22', tussCode: '10101012' }],
        }),
      }],
    });
    mockedPrisma.insurance.findFirst.mockResolvedValueOnce({
      tissRegistroAns: '123456', tissOperadoraCnpj: '12345678000195', tissVersao: '3.05.00',
      tissPrestadorCnpj: '10987654000199', tissPrestadorCnes: '1234567', tissCodigoPrestadorOperadora: 'COD123',
    });
    mockedPrisma.tissBatch.update.mockResolvedValueOnce({ id: 'tb-1' });
    const xmlRes = await app.inject({ method: 'GET', url: '/tiss-batches/tb-1/xml' });
    expect(xmlRes.statusCode).toBe(200);
    expect(xmlRes.body).toContain('<guiaConsulta>');

    await app.close();
  });

  it('validates xml generation with missing tiss config fields and guide divergence', async () => {
    const batchWithDivergentGuide = {
      id: 'tb-1',
      isActive: true,
      status: 'DRAFT',
      batchNumber: 'TISS-202604-0001',
      competenceMonth: '2026-04',
      convention: 'Unimed',
      items: [{
        id: 'it-1',
        guideNumber: 'GUIA-1',
        invoice: validInvoice({
          total: 999,
          procedureItems: [{ totalValue: 50, quantity: 1, unitValue: 50, procedureName: 'PROC' }],
        }),
      }],
    };

    const app = await buildApp();

    // incomplete tiss config (missing fields)
    mockedPrisma.tissBatch.findUnique.mockResolvedValueOnce(batchWithDivergentGuide);
    mockedPrisma.insurance.findFirst.mockResolvedValueOnce({
      tissRegistroAns: '123456',
      // missing other required fields
    });
    let res = await app.inject({ method: 'GET', url: '/tiss-batches/tb-1/xml' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/incompleta/i);

    // guide totals divergence in xml generation
    mockedPrisma.tissBatch.findUnique.mockResolvedValueOnce(batchWithDivergentGuide);
    mockedPrisma.insurance.findFirst.mockResolvedValueOnce({
      tissRegistroAns: '123456',
      tissOperadoraCnpj: '12345678000195',
      tissVersao: '3.05.00',
      tissPrestadorCnpj: '10987654000199',
      tissPrestadorCnes: '1234567',
      tissCodigoPrestadorOperadora: 'COD123',
    });
    res = await app.inject({ method: 'GET', url: '/tiss-batches/tb-1/xml' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/divergente/i);

    await app.close();
  });
});
