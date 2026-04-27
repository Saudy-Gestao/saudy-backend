import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import routes from '../../src/modules/procedures/routes/procedure-nursing-templates';
import prisma from '../../src/modules/procedures/lib/prisma';

vi.mock('../../src/modules/procedures/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    procedure: { findFirst: vi.fn() },
    procedureNursingTemplate: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    procedureNursingQuestion: { create: vi.fn(), deleteMany: vi.fn() },
    procedureNursingQuestionOption: { createMany: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const mockedPrisma = prisma as any;

const tx = {
  procedureNursingTemplate: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  procedureNursingQuestion: { create: vi.fn(), deleteMany: vi.fn() },
  procedureNursingQuestionOption: { createMany: vi.fn(), deleteMany: vi.fn() },
};

async function buildApp(opts?: { unauthorized?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1' };
  });
  await app.register(routes, { prefix: '/nursing-templates' });
  return app;
}

describe('procedure nursing templates routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b-1' } } });
    mockedPrisma.procedure.findFirst.mockResolvedValue({ id: 'p-1' });
    mockedPrisma.procedureNursingTemplate.findMany.mockResolvedValue([{ id: 't-1', questions: [] }]);
    mockedPrisma.procedureNursingTemplate.count.mockResolvedValue(1);
    mockedPrisma.procedureNursingTemplate.findFirst.mockResolvedValue(null);
    mockedPrisma.procedureNursingTemplate.update.mockResolvedValue({ id: 't-1', isActive: false });

    tx.procedureNursingTemplate.create.mockResolvedValue({ id: 't-1' });
    tx.procedureNursingTemplate.findUnique.mockResolvedValue({ id: 't-1', questions: [] });
    tx.procedureNursingTemplate.update.mockResolvedValue({ id: 't-1' });
    tx.procedureNursingQuestion.create.mockResolvedValue({ id: 'q-1' });
    tx.procedureNursingQuestion.deleteMany.mockResolvedValue({ count: 1 });
    tx.procedureNursingQuestionOption.createMany.mockResolvedValue({ count: 1 });
    tx.procedureNursingQuestionOption.deleteMany.mockResolvedValue({ count: 1 });

    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));
  });

  it('handles auth/list/get', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/nursing-templates' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    const app = await buildApp();
    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/nursing-templates' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/nursing-templates?search=abc' });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: '/nursing-templates/t-1' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.procedureNursingTemplate.findFirst.mockResolvedValueOnce({ id: 't-1', questions: [] });
    res = await app.inject({ method: 'GET', url: '/nursing-templates/t-1' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('creates template with validations and duplicate checks', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/nursing-templates', payload: { name: '' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.procedure.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'POST', url: '/nursing-templates', payload: { procedureId: 'p-1', name: 'A' } });
    expect(res.statusCode).toBe(404);

    mockedPrisma.procedureNursingTemplate.findFirst.mockResolvedValueOnce({ id: 'dup' });
    res = await app.inject({ method: 'POST', url: '/nursing-templates', payload: { procedureId: 'p-1', name: 'A' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.procedureNursingTemplate.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'POST', url: '/nursing-templates', payload: { procedureId: 'p-1', name: 'A', collectHeight: true, questions: [{ label: 'Q1', responseType: 'TEXT', options: [{ label: 'op' }] }] } });
    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it('updates and deactivates template', async () => {
    const app = await buildApp();

    mockedPrisma.procedureNursingTemplate.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 't-1', procedureId: 'p-1' })
      .mockResolvedValueOnce({ id: 'dup' })
      .mockResolvedValueOnce({ id: 't-1', procedureId: 'p-1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 't-1' });

    let res = await app.inject({ method: 'PUT', url: '/nursing-templates/t-1', payload: {} });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/nursing-templates/t-1', payload: { procedureId: 'p-1' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.procedureNursingTemplate.findFirst.mockResolvedValueOnce({ id: 't-1', procedureId: 'p-1' });
    mockedPrisma.procedure.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'PUT', url: '/nursing-templates/t-1', payload: { procedureId: 'p-2' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/nursing-templates/t-1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/nursing-templates/t-1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('updates template with normalized questions and triage fields', async () => {
    const app = await buildApp();

    mockedPrisma.procedureNursingTemplate.findFirst
      .mockResolvedValueOnce({ id: 't-1', procedureId: 'p-1' })
      .mockResolvedValueOnce(null);

    tx.procedureNursingTemplate.findUnique.mockResolvedValueOnce({
      id: 't-1',
      questions: [
        {
          id: 'q-2',
          label: 'Segunda',
          orderIndex: 2,
          options: [
            { id: 'o-2', label: 'B', orderIndex: 2 },
            { id: 'o-1', label: 'A', orderIndex: 1 },
          ],
        },
        {
          id: 'q-1',
          label: 'Primeira',
          orderIndex: 1,
          options: [],
        },
      ],
    });

    const res = await app.inject({
      method: 'PUT',
      url: '/nursing-templates/t-1',
      payload: {
        name: '  Novo Nome  ',
        description: '',
        isActive: false,
        collectHeight: true,
        collectWeight: true,
        collectBloodPressure: true,
        collectTemperature: true,
        collectHeartRate: true,
        collectOxygenSaturation: true,
        collectGlucose: true,
        collectPregnancyCheck: true,
        questions: [
          { label: '   ', responseType: 'TEXT' },
          {
            label: 'Pergunta 1',
            responseType: 'single_choice',
            options: [
              { label: '  ', value: 'x' },
              { label: 'Opcao A' },
            ],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(tx.procedureNursingQuestionOption.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.procedureNursingQuestion.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.procedureNursingQuestion.create).toHaveBeenCalledTimes(1);
    expect(tx.procedureNursingQuestionOption.createMany).toHaveBeenCalledTimes(1);

    const body = res.json();
    expect(body.questions[0].id).toBe('q-1');
    expect(body.questions[1].id).toBe('q-2');
    expect(body.questions[1].options[0].id).toBe('o-1');
    expect(body.questions[1].options[1].id).toBe('o-2');

    await app.close();
  });

  it('lists with procedure and isActive filters', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/nursing-templates?procedureId=p-1&isActive=false&limit=5&offset=2',
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.procedureNursingTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          branchId: 'b-1',
          procedureId: 'p-1',
          isActive: false,
        }),
        take: 5,
        skip: 2,
      }),
    );

    await app.close();
  });
});
