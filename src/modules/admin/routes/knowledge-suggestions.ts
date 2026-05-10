import { FastifyInstance } from 'fastify';
import prismaModule from '../../../lib/prisma';

const prisma: any = (prismaModule as any)?.default ?? prismaModule;

const VALID_STATUSES = ['pending', 'approved', 'rejected'] as const;
type SuggestionStatus = (typeof VALID_STATUSES)[number];

function normalizeStatus(value: unknown): SuggestionStatus | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase() as SuggestionStatus;
  return VALID_STATUSES.includes(lower) ? lower : null;
}

export default async function knowledgeSuggestionsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    try { await request.jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
    const user = (request as any).user;
    if (user?.role !== 'ADMIN' && user?.role !== 'SUPERADMIN') {
      return reply.code(403).send({ error: 'Acesso negado' });
    }
  });

  // GET /admin/knowledge-suggestions?status=pending
  app.get('/', async (request, reply) => {
    const { status } = request.query as { status?: string };
    const where = status && VALID_STATUSES.includes(status as SuggestionStatus) ? { status } : {};
    const items = await prisma.knowledgeSuggestion.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    return reply.send(items);
  });

  // GET /admin/knowledge-suggestions/:id
  app.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const item = await prisma.knowledgeSuggestion.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: 'Não encontrada' });
    return reply.send(item);
  });

  // PATCH /admin/knowledge-suggestions/:id
  app.patch('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status, answer } = request.body as { status?: string; answer?: string };

    const normalizedStatus = normalizeStatus(status);
    if (!normalizedStatus) return reply.code(400).send({ error: 'status inválido. Use: pending, approved, rejected' });

    const existing = await prisma.knowledgeSuggestion.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Não encontrada' });

    const updated = await prisma.knowledgeSuggestion.update({
      where: { id },
      data: {
        status: normalizedStatus,
        ...(typeof answer === 'string' && answer.trim() ? { answer: answer.trim() } : {}),
        reviewedAt: new Date(),
      },
    });
    return reply.send(updated);
  });

  // DELETE /admin/knowledge-suggestions/:id
  app.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.knowledgeSuggestion.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Não encontrada' });
    await prisma.knowledgeSuggestion.delete({ where: { id } });
    return reply.send({ ok: true });
  });
}
