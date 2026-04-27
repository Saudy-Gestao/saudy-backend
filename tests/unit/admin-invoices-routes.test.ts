import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import invoiceRoutes from '../../src/modules/admin/routes/invoices';
import prisma from '../../src/modules/admin/lib/prisma';

vi.mock('../../src/modules/admin/lib/prisma', () => ({
  default: {
    invoice: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

const mockedPrisma = prisma as any;

async function buildApp() {
  const app = Fastify();
  app.addSchema({ $id: 'InvoiceCreate', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'InvoiceUpdate', type: 'object', additionalProperties: true });
  app.addSchema({ $id: 'Invoice', type: 'object', additionalProperties: true });
  await app.register(invoiceRoutes, { prefix: '/invoices' });
  return app;
}

describe('admin invoices routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists invoices with filters', async () => {
    mockedPrisma.invoice.findMany.mockResolvedValue([{ id: '1' }]);
    mockedPrisma.invoice.count.mockResolvedValue(1);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/invoices?status=EMITIDA&search=maria&convention=x' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [{ id: '1' }], total: 1 });
    expect(mockedPrisma.invoice.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'EMITIDA', convention: 'x' }) }));
    await app.close();
  });

  it('gets by id and 404 when missing', async () => {
    mockedPrisma.invoice.findUnique.mockResolvedValueOnce({ id: '1' }).mockResolvedValueOnce(null);

    const app = await buildApp();
    let res = await app.inject({ method: 'GET', url: '/invoices/1' });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: '/invoices/2' });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('creates invoices and retries on number collision', async () => {
    mockedPrisma.invoice.create
      .mockRejectedValueOnce({ code: 'P2002', meta: { target: ['number'] } })
      .mockResolvedValueOnce({ id: '2', number: 'FAT-1' });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/invoices',
      payload: {
        patientName: 'Maria',
        value: 100,
        discount: 10,
        packageValue: 3,
        materialsValue: 2,
        feesValue: 1,
        dailyValue: 4,
        gasesValue: 5,
        opmeValue: 6,
        expectedDiscountValue: 7,
        expectedGlosaValue: 8,
        dueDate: '2026/01/01',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockedPrisma.invoice.create).toHaveBeenCalledTimes(2);

    const secondCallData = mockedPrisma.invoice.create.mock.calls[1][0].data;
    expect(secondCallData.total).toBe(96);
    expect(secondCallData.dueDate).toBeInstanceOf(Date);

    await app.close();
  });

  it('returns p2002 validation message when conflicting unique field is not invoice number', async () => {
    mockedPrisma.invoice.create.mockRejectedValue({ code: 'P2002', meta: { target: ['sourceAppointmentId'] } });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/invoices',
      payload: { number: 'ABC', value: 100 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'sourceAppointmentId already exists' });

    await app.close();
  });

  it('returns generic failure after exhausting retries on number collision', async () => {
    mockedPrisma.invoice.create.mockRejectedValue({ code: 'P2002', meta: { target: ['number'] } });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/invoices',
      payload: { value: 100 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'Failed to create invoice',
      details: 'Failed to generate unique invoice number after multiple attempts',
    });
    expect(mockedPrisma.invoice.create).toHaveBeenCalledTimes(5);

    await app.close();
  });

  it('updates invoice with date parsing and total recomputation', async () => {
    mockedPrisma.invoice.findUnique.mockResolvedValue({
      value: 120,
      discount: 20,
      packageValue: 5,
      materialsValue: 0,
      feesValue: 0,
      dailyValue: 0,
      gasesValue: 0,
      opmeValue: 0,
      expectedDiscountValue: 0,
      expectedGlosaValue: 0,
    });
    mockedPrisma.invoice.update.mockResolvedValue({ id: '1' });

    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/invoices/1',
      payload: {
        value: 200,
        dueDate: '2026-02-01',
        authorizationDate: '2026-02-03',
        authorizationExpiryDate: '2026-02-07',
      },
    });

    expect(res.statusCode).toBe(200);
    const sentData = mockedPrisma.invoice.update.mock.calls[0][0].data;
    expect(sentData.total).toBe(185);
    expect(sentData.dueDate).toBeInstanceOf(Date);
    expect(sentData.authorizationDate).toBeInstanceOf(Date);
    expect(sentData.authorizationExpiryDate).toBeInstanceOf(Date);

    await app.close();
  });

  it('handles update errors', async () => {
    mockedPrisma.invoice.update.mockRejectedValue(new Error('boom'));

    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/invoices/1',
      payload: { status: 'PAGA' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Failed to update', details: 'boom' });

    await app.close();
  });

  it('deletes invoices', async () => {
    mockedPrisma.invoice.delete.mockResolvedValue({});

    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/invoices/1' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'Deleted' });

    await app.close();
  });
});
