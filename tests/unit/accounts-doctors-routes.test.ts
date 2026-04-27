import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import doctorRoutes from '../../src/modules/accounts/routes/doctors';
import prisma from '../../src/modules/accounts/lib/prisma';

vi.mock('../../src/modules/accounts/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    doctor: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
    sector: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    appointment: {
      count: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

const mockedPrisma = prisma as any;

function buildTxMock() {
  return {
    doctor: {
      create: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    doctorRoom: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
}

async function buildApp() {
  const app = Fastify();
  app.decorateRequest('jwtVerify', async function jwtVerify() {});
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    (request as any).user = { id: 'u-1' };
  });

  app.addSchema({ $id: 'Doctor', type: 'object', additionalProperties: true });

  await app.register(doctorRoutes, { prefix: '/doctors' });
  return app;
}

describe('accounts doctors routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b1' } } });
  });

  it('returns 403 when user has no branch', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/doctors' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'User not associated with a branch' });
    await app.close();
  });

  it('lists doctors and maps response structure', async () => {
    mockedPrisma.doctor.findMany.mockResolvedValue([
      {
        id: 'd1',
        roomId: 'r1',
        roomLinks: [{ id: 'l1', roomId: 'r2', room: { id: 'r2', name: 'Sala 2', branchId: 'b1' } }],
        workingSchedules: '[{"days":[1],"hoursStart":"08:00","hoursEnd":"12:00"}]',
      },
    ]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/doctors?specialty=cardio&search=ana&isActive=true' });

    expect(res.statusCode).toBe(200);
    expect(res.json()[0].roomIds).toEqual(['r1', 'r2']);
    expect(res.json()[0].rooms).toHaveLength(1);
    expect(res.json()[0].workingSchedules).toEqual([{ days: [1], hoursStart: '08:00', hoursEnd: '12:00' }]);

    await app.close();
  });

  it('gets doctor by id and by crm', async () => {
    mockedPrisma.doctor.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'd1', roomLinks: [], workingSchedules: '[]' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'd1', roomLinks: [], workingSchedules: '[]' });

    const app = await buildApp();

    let res = await app.inject({ method: 'GET', url: '/doctors/d1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/doctors/d1' });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: '/doctors/crm/123/SP' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/doctors/crm/123/sp' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('validates doctor creation with empty body and invalid fields', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/doctors', payload: {} });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/doctors',
      payload: {
        name: '',
        crm: '',
        crmState: '',
        email: 'x',
        cellphone: '123',
        phone: '123',
        cpf: '1',
        birthDate: '3000-01-01',
        gender: 'X',
        specialty: '',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Validation failed');

    await app.close();
  });

  it('creates doctor with roomIds and legacy working schedule fields', async () => {
    const tx = buildTxMock();
    tx.doctor.create.mockResolvedValue({ id: 'd1', roomId: 'r1' });
    tx.doctor.findUniqueOrThrow.mockResolvedValue({ id: 'd1', roomLinks: [], workingSchedules: '[]' });
    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));
    mockedPrisma.sector.findMany.mockResolvedValue([{ id: 'r1', branchId: 'b1' }]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/doctors',
      payload: {
        name: 'Dra Ana',
        crm: '12345',
        crmState: 'SP',
        email: 'ANA@MAIL.COM',
        cellphone: '11999999999',
        cpf: '529.982.247-25',
        birthDate: '1990-01-01',
        gender: 'female',
        specialty: 'Cardio',
        roomIds: ['r1', 'r1'],
        workingDays: [1, 2],
        workingHoursStart: '08:00',
        workingHoursEnd: '12:00',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(tx.doctor.create).toHaveBeenCalled();
    expect(tx.doctorRoom.createMany).toHaveBeenCalled();

    await app.close();
  });

  it('handles create invalid room and create errors', async () => {
    const tx = buildTxMock();
    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));
    mockedPrisma.sector.findMany.mockResolvedValue([]);

    const app = await buildApp();

    let res = await app.inject({
      method: 'POST',
      url: '/doctors',
      payload: {
        name: 'Dr A', crm: '1', crmState: 'SP', email: 'a@a.com', cellphone: '11999999999',
        cpf: '52998224725', birthDate: '1990-01-01', gender: 'MALE', specialty: 'Cardio', roomIds: ['bad'],
      },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.sector.findMany.mockResolvedValue([{ id: 'r1', branchId: 'b1' }]);
    mockedPrisma.$transaction.mockRejectedValueOnce({ code: 'P2002', meta: { target: ['crm'] } });
    res = await app.inject({
      method: 'POST',
      url: '/doctors',
      payload: {
        name: 'Dr A', crm: '1', crmState: 'SP', email: 'a@a.com', cellphone: '11999999999',
        cpf: '52998224725', birthDate: '1990-01-01', gender: 'MALE', specialty: 'Cardio', roomIds: ['r1'],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Validation failed');

    mockedPrisma.$transaction.mockRejectedValueOnce(new Error('boom'));
    res = await app.inject({
      method: 'POST',
      url: '/doctors',
      payload: {
        name: 'Dr A', crm: '1', crmState: 'SP', email: 'a@a.com', cellphone: '11999999999',
        cpf: '52998224725', birthDate: '1990-01-01', gender: 'MALE', specialty: 'Cardio', roomIds: ['r1'],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Failed to create doctor');

    await app.close();
  });

  it('updates doctor and syncs rooms', async () => {
    const tx = buildTxMock();
    tx.doctor.findUniqueOrThrow.mockResolvedValue({ id: 'd1', roomLinks: [], workingSchedules: '[]' });
    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));
    mockedPrisma.doctor.findFirst.mockResolvedValue({ id: 'd1', branchId: 'b1' });
    mockedPrisma.sector.findMany.mockResolvedValue([{ id: 'r1', branchId: 'b1' }]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/doctors/d1',
      payload: { email: 'new@mail.com', cpf: '52998224725', roomIds: ['r1'], workingSchedules: [] },
    });

    expect(res.statusCode).toBe(200);
    expect(tx.doctor.update).toHaveBeenCalled();
    expect(tx.doctorRoom.deleteMany).toHaveBeenCalledWith({ where: { doctorId: 'd1' } });

    await app.close();
  });

  it('handles update validation, not found and errors', async () => {
    mockedPrisma.doctor.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: 'd1', branchId: 'b1' });

    const app = await buildApp();

    let res = await app.inject({ method: 'PUT', url: '/doctors/d1', payload: { email: 'bad' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/doctors/d1', payload: { cpf: '1' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.sector.findUnique.mockResolvedValue(null);
    res = await app.inject({ method: 'PUT', url: '/doctors/d1', payload: { roomId: 'x', cpf: '52998224725' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.sector.findUnique.mockResolvedValue({ id: 'r1', branchId: 'b1' });
    mockedPrisma.$transaction.mockRejectedValueOnce({ code: 'P2002', meta: { target: ['email'] } });
    res = await app.inject({ method: 'PUT', url: '/doctors/d1', payload: { email: 'a@a.com' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.$transaction.mockRejectedValueOnce(new Error('bad update'));
    res = await app.inject({ method: 'PUT', url: '/doctors/d1', payload: { email: 'a@a.com' } });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('deletes doctor with constraints', async () => {
    mockedPrisma.doctor.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'd1', name: 'Dr A' })
      .mockResolvedValueOnce({ id: 'd1', name: 'Dr A' });
    mockedPrisma.appointment.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0);
    mockedPrisma.doctor.delete.mockResolvedValueOnce({});

    const app = await buildApp();

    let res = await app.inject({ method: 'DELETE', url: '/doctors/d1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/doctors/d1' });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'DELETE', url: '/doctors/d1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('handles delete P2003 and internal errors', async () => {
    mockedPrisma.doctor.findFirst
      .mockResolvedValueOnce({ id: 'd1', name: 'Dr A' })
      .mockResolvedValueOnce({ id: 'd1', name: 'Dr A' });
    mockedPrisma.appointment.count.mockResolvedValue(0);
    mockedPrisma.doctor.delete
      .mockRejectedValueOnce({ code: 'P2003' })
      .mockRejectedValueOnce(new Error('internal'));

    const app = await buildApp();

    let res = await app.inject({ method: 'DELETE', url: '/doctors/d1' });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'DELETE', url: '/doctors/d1' });
    expect(res.statusCode).toBe(500);

    await app.close();
  });

  it('lists specialties from primary and secondary fields', async () => {
    mockedPrisma.doctor.findMany.mockResolvedValue([
      { specialty: 'Cardio', specialties: ['Imagem', 'Cardio'] },
      { specialty: 'Pediatria', specialties: [] },
    ]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/doctors/meta/specialties' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(['Cardio', 'Imagem', 'Pediatria']);

    await app.close();
  });
});
