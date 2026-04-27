import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import routes from '../../src/modules/procedures/routes/procedure-anamnesis-templates';
import prisma from '../../src/modules/procedures/lib/prisma';

vi.mock('../../src/modules/procedures/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    procedure: { findFirst: vi.fn() },
    procedureAnamnesisTemplate: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    procedureAnamnesisQuestion: { create: vi.fn(), deleteMany: vi.fn() },
    procedureAnamnesisQuestionOption: { createMany: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const mockedPrisma = prisma as any;

const tx = {
  procedureAnamnesisTemplate: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  procedureAnamnesisQuestion: { create: vi.fn(), deleteMany: vi.fn() },
  procedureAnamnesisQuestionOption: { createMany: vi.fn(), deleteMany: vi.fn() },
};

async function buildApp(opts?: { unauthorized?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1' };
  });
  await app.register(routes, { prefix: '/anamnesis-templates' });
  return app;
}

describe('procedure anamnesis templates routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'b-1' } } });
    mockedPrisma.procedure.findFirst.mockResolvedValue({ id: 'p-1' });
    mockedPrisma.procedureAnamnesisTemplate.findMany.mockResolvedValue([{ id: 't-1', questions: [] }]);
    mockedPrisma.procedureAnamnesisTemplate.count.mockResolvedValue(1);
    mockedPrisma.procedureAnamnesisTemplate.findFirst.mockResolvedValue(null);
    mockedPrisma.procedureAnamnesisTemplate.update.mockResolvedValue({ id: 't-1', isActive: false });

    tx.procedureAnamnesisTemplate.create.mockResolvedValue({ id: 't-1' });
    tx.procedureAnamnesisTemplate.findUnique.mockResolvedValue({ id: 't-1', questions: [] });
    tx.procedureAnamnesisTemplate.update.mockResolvedValue({ id: 't-1' });
    tx.procedureAnamnesisQuestion.create.mockResolvedValue({ id: 'q-1' });
    tx.procedureAnamnesisQuestion.deleteMany.mockResolvedValue({ count: 1 });
    tx.procedureAnamnesisQuestionOption.createMany.mockResolvedValue({ count: 1 });
    tx.procedureAnamnesisQuestionOption.deleteMany.mockResolvedValue({ count: 1 });

    mockedPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));
  });

  it('handles auth/list/get', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/anamnesis-templates' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    const app = await buildApp();
    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/anamnesis-templates' });
    expect(res.statusCode).toBe(403);

    res = await app.inject({ method: 'GET', url: '/anamnesis-templates?search=abc' });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: '/anamnesis-templates/t-1' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.procedureAnamnesisTemplate.findFirst.mockResolvedValueOnce({ id: 't-1', questions: [] });
    res = await app.inject({ method: 'GET', url: '/anamnesis-templates/t-1' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('creates template with validations and duplicate checks', async () => {
    const app = await buildApp();

    let res = await app.inject({ method: 'POST', url: '/anamnesis-templates', payload: { name: '' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.procedure.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'POST', url: '/anamnesis-templates', payload: { procedureId: 'p-1', name: 'A' } });
    expect(res.statusCode).toBe(404);

    mockedPrisma.procedureAnamnesisTemplate.findFirst.mockResolvedValueOnce({ id: 'dup' });
    res = await app.inject({ method: 'POST', url: '/anamnesis-templates', payload: { procedureId: 'p-1', name: 'A' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.procedureAnamnesisTemplate.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'POST', url: '/anamnesis-templates', payload: { procedureId: 'p-1', name: 'A', questions: [{ label: 'Q1', responseType: 'TEXT', options: [{ label: 'op' }] }] } });
    expect(res.statusCode).toBe(201);

    await app.close();
  });

  it('updates and deactivates template', async () => {
    const app = await buildApp();

    mockedPrisma.procedureAnamnesisTemplate.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 't-1', procedureId: 'p-1' })
      .mockResolvedValueOnce({ id: 'dup' })
      .mockResolvedValueOnce({ id: 't-1', procedureId: 'p-1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 't-1' });

    let res = await app.inject({ method: 'PUT', url: '/anamnesis-templates/t-1', payload: {} });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/anamnesis-templates/t-1', payload: { procedureId: 'p-1' } });
    expect(res.statusCode).toBe(400);

    mockedPrisma.procedureAnamnesisTemplate.findFirst.mockResolvedValueOnce({ id: 't-1', procedureId: 'p-1' });
    mockedPrisma.procedure.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'PUT', url: '/anamnesis-templates/t-1', payload: { procedureId: 'p-2' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/anamnesis-templates/t-1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/anamnesis-templates/t-1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('updates template with normalized questions and sorted nested collections', async () => {
    const app = await buildApp();

    mockedPrisma.procedureAnamnesisTemplate.findFirst
      .mockResolvedValueOnce({ id: 't-1', procedureId: 'p-1' })
      .mockResolvedValueOnce(null);

    tx.procedureAnamnesisTemplate.findUnique.mockResolvedValueOnce({
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
      url: '/anamnesis-templates/t-1',
      payload: {
        name: '  Novo Nome  ',
        description: '',
        isActive: false,
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
    expect(tx.procedureAnamnesisQuestionOption.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.procedureAnamnesisQuestion.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.procedureAnamnesisQuestion.create).toHaveBeenCalledTimes(1);
    expect(tx.procedureAnamnesisQuestionOption.createMany).toHaveBeenCalledTimes(1);

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
      url: '/anamnesis-templates?procedureId=p-1&isActive=false&limit=5&offset=2',
    });

    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.procedureAnamnesisTemplate.findMany).toHaveBeenCalledWith(
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
