import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import medicalEquipmentRoutes from '../../src/modules/procedures/routes/medical-equipments';
import prisma from '../../src/modules/procedures/lib/prisma';

vi.mock('../../src/modules/procedures/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    medicalEquipment: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    sector: { findFirst: vi.fn() },
    procedure: { count: vi.fn() },
    medicalEquipmentProcedure: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const mockedPrisma = prisma as any;

const tx = {
  medicalEquipmentProcedure: { deleteMany: vi.fn() },
  medicalEquipment: { update: vi.fn() },
};

async function buildApp(opts?: { unauthorized?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1' };
  });

  await app.register(medicalEquipmentRoutes, { prefix: '/medical-equipments' });
  return app;
}

describe('procedures medical-equipments routes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.resetAllMocks();

    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b-1' } } });
    mockedPrisma.medicalEquipment.findMany.mockResolvedValue([{ id: 'm-1', procedures: [] }]);
    mockedPrisma.medicalEquipment.count.mockResolvedValue(1);
    mockedPrisma.medicalEquipment.findFirst.mockResolvedValue(null);
    mockedPrisma.medicalEquipment.create.mockResolvedValue({ id: 'm-1', procedures: [] });
    mockedPrisma.medicalEquipment.update.mockResolvedValue({ id: 'm-1', procedures: [] });

    mockedPrisma.sector.findFirst.mockResolvedValue({ id: 'room-1' });
    mockedPrisma.procedure.count.mockResolvedValue(1);
    mockedPrisma.medicalEquipmentProcedure.deleteMany.mockResolvedValue({ count: 1 });

    tx.medicalEquipmentProcedure.deleteMany.mockResolvedValue({ count: 1 });
    tx.medicalEquipment.update.mockResolvedValue({ id: 'm-1', procedures: [] });
    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));
  });

  it('handles auth, list and get', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/medical-equipments' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    const app = await buildApp();

    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/medical-equipments' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/medical-equipments?search=tc&modality=CT' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    res = await app.inject({ method: 'GET', url: '/medical-equipments/m-1' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.medicalEquipment.findFirst.mockResolvedValueOnce({ id: 'm-1', procedures: [{ procedureId: 'p-1' }] });
    res = await app.inject({ method: 'GET', url: '/medical-equipments/m-1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('creates medical equipment with validations and errors', async () => {
    const app = await buildApp();

    mockedPrisma.sector.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({
      method: 'POST',
      url: '/medical-equipments',
      payload: { name: 'CT 1', roomId: 'room-x' },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.procedure.count.mockResolvedValueOnce(0);
    res = await app.inject({
      method: 'POST',
      url: '/medical-equipments',
      payload: { name: 'CT 1', procedureIds: ['p-1'] },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.medicalEquipment.create.mockRejectedValueOnce(new Error('boom'));
    res = await app.inject({
      method: 'POST',
      url: '/medical-equipments',
      payload: { name: 'CT 1', supportsStore: true },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/medical-equipments',
      payload: { name: 'CT 1', procedureIds: ['p-1'] },
    });
    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it('updates medical equipment and handles edge cases', async () => {
    const app = await buildApp();

    mockedPrisma.medicalEquipment.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'm-1' })
      .mockResolvedValueOnce({ id: 'm-1' })
      .mockResolvedValueOnce({ id: 'm-1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'm-1', integrationType: 'MANUAL' })
      .mockResolvedValueOnce({ id: 'm-1', integrationType: 'MWL_BRIDGE', supportsWorklist: false, supportsStore: false, dicomWebPath: null });

    let res = await app.inject({ method: 'PUT', url: '/medical-equipments/m-1', payload: { name: 'X' } });
    expect(res.statusCode).toBe(404);

    mockedPrisma.sector.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'PUT', url: '/medical-equipments/m-1', payload: { roomId: 'room-x' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.procedure.count.mockResolvedValueOnce(0);
    res = await app.inject({ method: 'PUT', url: '/medical-equipments/m-1', payload: { procedureIds: ['p-1'] } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.$transaction.mockRejectedValueOnce(new Error('bad update')).mockImplementation(async (cb: any) => cb(tx));
    res = await app.inject({ method: 'PUT', url: '/medical-equipments/m-1', payload: { name: 'OK', procedureIds: [] } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/medical-equipments/m-1/test-connection' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'POST', url: '/medical-equipments/m-1/test-connection' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('SKIPPED');

    res = await app.inject({ method: 'POST', url: '/medical-equipments/m-1/test-connection' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('WARNING');

    mockedPrisma.medicalEquipment.findFirst.mockResolvedValueOnce({
      id: 'm-1',
      integrationType: 'MWL_BRIDGE',
      supportsWorklist: true,
      mwlHost: '127.0.0.1',
      mwlPort: 1,
      supportsStore: false,
      dicomWebPath: null,
    });
    res = await app.inject({ method: 'POST', url: '/medical-equipments/m-1/test-connection' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ERROR');
    expect(res.json().ok).toBe(false);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    mockedPrisma.medicalEquipment.findFirst.mockResolvedValueOnce({
      id: 'm-1',
      integrationType: 'MWL_BRIDGE',
      supportsWorklist: false,
      supportsStore: false,
      dicomWebPath: 'https://dicom.example/web',
    });
    res = await app.inject({ method: 'POST', url: '/medical-equipments/m-1/test-connection' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('SUCCESS');
    expect(res.json().message).toContain('DICOMweb respondeu');

    await app.close();
  });
});
