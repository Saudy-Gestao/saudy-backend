import { randomBytes } from 'crypto';
import { FastifyInstance } from 'fastify';
import { Prisma, TicketPriority, TicketStatus, TicketType } from '@prisma/client';
import prisma from '../lib/prisma';
import { getAnexosStorage } from '../../../lib/storage';

const ticketStatusValues = ['OPEN', 'TRIAGE', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
const ticketTypeValues = ['BUG', 'ERROR', 'IMPROVEMENT'] as const;
const ticketPriorityValues = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
const ticketSortValues = ['NEWEST', 'OLDEST', 'PRIORITY_HIGH', 'PRIORITY_LOW'] as const;
const maxAttachmentBytes = 5 * 1024 * 1024;
const resolveConfirmationWindowMs = 24 * 60 * 60 * 1000;
const resolvedConfirmationMessage = 'Seu chamado foi marcado como resolvido. Se estiver tudo certo, confirme o fechamento do ticket. Caso não confirme em até 24h, ele será fechado automaticamente.';

function normalizeOptionalString(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeStatus(value: unknown): TicketStatus | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return ticketStatusValues.includes(normalized as TicketStatus) ? (normalized as TicketStatus) : null;
}

function normalizeType(value: unknown): TicketType | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return ticketTypeValues.includes(normalized as TicketType) ? (normalized as TicketType) : null;
}

function normalizePriority(value: unknown): TicketPriority | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return ticketPriorityValues.includes(normalized as TicketPriority) ? (normalized as TicketPriority) : null;
}

function normalizeSort(value: unknown): (typeof ticketSortValues)[number] {
  if (typeof value !== 'string') return 'NEWEST';
  const normalized = value.trim().toUpperCase();
  return ticketSortValues.includes(normalized as (typeof ticketSortValues)[number])
    ? (normalized as (typeof ticketSortValues)[number])
    : 'NEWEST';
}

function normalizeMessage(value: unknown) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeAttachment(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const raw = value as {
    name?: unknown;
    mimeType?: unknown;
    sizeBytes?: unknown;
    base64?: unknown;
  };

  const name = String(raw.name || '').trim();
  const mimeType = String(raw.mimeType || '').trim();
  const sizeBytes = Number(raw.sizeBytes);
  const base64 = String(raw.base64 || '').trim();

  if (!name || !mimeType || !base64 || !Number.isFinite(sizeBytes) || sizeBytes <= 0) return null;
  if (!base64.startsWith('data:')) return null;
  if (sizeBytes > maxAttachmentBytes) return null;

  return { name, mimeType, sizeBytes, base64 };
}

const sanitizeFileName = (value: string) => String(value || 'arquivo')
  .replace(/[^a-zA-Z0-9._-]/g, '_')
  .replace(/_+/g, '_')
  .slice(0, 120);

const decodeBase64 = (raw: string): Buffer => {
  const trimmed = String(raw || '').trim();
  const normalized = trimmed.includes(',') ? trimmed.split(',').pop() || '' : trimmed;
  return Buffer.from(normalized, 'base64');
};

const makeObjectSuffix = () => randomBytes(8).toString('hex');

export default async function ticketRoutes(app: FastifyInstance) {
  const closeExpiredResolvedTickets = async () => {
    const now = new Date();
    await prisma.ticket.updateMany({
      where: {
        status: TicketStatus.RESOLVED,
        resolutionConfirmationDeadlineAt: { lte: now },
      },
      data: {
        status: TicketStatus.CLOSED,
        updatedAt: now,
      },
    });
  };

  app.get('/', {
    preHandler: async (request) => { await request.jwtVerify(); },
    schema: {
      summary: 'List support tickets',
      tags: ['Tickets'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          status: { type: 'string', enum: ['ALL', ...ticketStatusValues] },
          type: { type: 'string', enum: ['ALL', ...ticketTypeValues] },
          priority: { type: 'string', enum: ['ALL', ...ticketPriorityValues] },
          sort: { type: 'string', enum: ticketSortValues, default: 'NEWEST' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { $ref: 'Ticket#' } },
            total: { type: 'number' },
            limit: { type: 'number' },
            offset: { type: 'number' },
          },
        },
      },
    },
  }, async (request) => {
    await closeExpiredResolvedTickets();
    const { search, status, type, priority, sort = 'NEWEST', limit = 50, offset = 0 } = request.query as {
      search?: string;
      status?: TicketStatus | 'ALL';
      type?: TicketType | 'ALL';
      priority?: TicketPriority | 'ALL';
      sort?: (typeof ticketSortValues)[number];
      limit?: number;
      offset?: number;
    };

    const where: Prisma.TicketWhereInput = {};
    const normalizedSearch = normalizeOptionalString(search);

    if (normalizedSearch) {
      where.OR = [
        { flow: { contains: normalizedSearch, mode: 'insensitive' } },
        { module: { contains: normalizedSearch, mode: 'insensitive' } },
        { description: { contains: normalizedSearch, mode: 'insensitive' } },
        { createdByName: { contains: normalizedSearch, mode: 'insensitive' } },
        { createdByEmail: { contains: normalizedSearch, mode: 'insensitive' } },
      ];
    }

    if (status && status !== 'ALL') {
      where.status = status;
    }

    if (type && type !== 'ALL') {
      const normalizedType = normalizeType(type);
      if (normalizedType) where.type = normalizedType;
    }

    if (priority && priority !== 'ALL') {
      const normalizedPriority = normalizePriority(priority);
      if (normalizedPriority) where.priority = normalizedPriority;
    }

    const normalizedSort = normalizeSort(sort);
    const orderBy: Prisma.TicketOrderByWithRelationInput[] = normalizedSort === 'OLDEST'
      ? [{ createdAt: 'asc' }]
      : normalizedSort === 'PRIORITY_HIGH'
        ? [{ priority: 'desc' }, { createdAt: 'desc' }]
        : normalizedSort === 'PRIORITY_LOW'
          ? [{ priority: 'asc' }, { createdAt: 'desc' }]
          : [{ createdAt: 'desc' }];

    const take = Number.isFinite(Number(limit)) ? Number(limit) : 50;
    const skip = Number.isFinite(Number(offset)) ? Number(offset) : 0;

    const [rows, total] = await Promise.all([
      prisma.ticket.findMany({
        where,
        take,
        skip,
        orderBy,
      }),
      prisma.ticket.count({ where }),
    ]);

    const items = rows.map((item: any) => {
      const hasUnreadUserMessage = Boolean(
        item.lastUserMessageAt
        && (!item.lastReadByAdminAt || item.lastUserMessageAt > item.lastReadByAdminAt),
      );
      return {
        ...item,
        hasUnreadUserMessage,
      };
    });

    return { items, total, limit: take, offset: skip };
  });

  app.patch('/:id/status', {
    preHandler: async (request) => { await request.jwtVerify(); },
    schema: {
      summary: 'Update ticket status',
      tags: ['Tickets'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      body: { $ref: 'TicketStatusUpdate#' },
      response: {
        200: { $ref: 'Ticket#' },
        400: { type: 'object', additionalProperties: true },
        404: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    await closeExpiredResolvedTickets();
    const { id } = request.params as { id: string };
    const body = request.body as { status?: string };
    const status = normalizeStatus(body?.status);

    if (!status) {
      return reply.code(400).send({ error: 'Validation failed', fields: { status: 'Status inválido' } });
    }

    const existing = await prisma.ticket.findUnique({ where: { id } });
    if (!existing) {
      return reply.code(404).send({ error: 'Ticket not found' });
    }

    const now = new Date();
    const updateData: Prisma.TicketUpdateInput = {
      status,
      resolutionConfirmationDeadlineAt: status === TicketStatus.RESOLVED ? existing.resolutionConfirmationDeadlineAt : null,
      resolutionConfirmedAt: status === TicketStatus.RESOLVED ? existing.resolutionConfirmedAt : null,
    };

    if (status === TicketStatus.RESOLVED && existing.status !== TicketStatus.RESOLVED) {
      const confirmationDeadline = new Date(now.getTime() + resolveConfirmationWindowMs);
      updateData.resolutionConfirmationDeadlineAt = confirmationDeadline;
      updateData.resolutionConfirmedAt = null;
      const [ticket] = await prisma.$transaction([
        prisma.ticket.update({
          where: { id },
          data: updateData,
        }),
        prisma.ticketMessage.create({
          data: {
            ticketId: id,
            authorRole: 'SYSTEM',
            authorName: 'Sistema',
            message: resolvedConfirmationMessage,
          },
        }),
      ]);
      return ticket;
    }

    const ticket = await prisma.ticket.update({ where: { id }, data: updateData });

    return ticket;
  });

  app.patch('/:id/priority', {
    preHandler: async (request) => { await request.jwtVerify(); },
    schema: {
      summary: 'Update ticket priority',
      tags: ['Tickets'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      body: { $ref: 'TicketPriorityUpdate#' },
      response: {
        200: { $ref: 'Ticket#' },
        400: { type: 'object', additionalProperties: true },
        404: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    await closeExpiredResolvedTickets();
    const { id } = request.params as { id: string };
    const body = request.body as { priority?: string };
    const priority = normalizePriority(body?.priority);

    if (!priority) {
      return reply.code(400).send({ error: 'Validation failed', fields: { priority: 'Prioridade inválida' } });
    }

    const existing = await prisma.ticket.findUnique({ where: { id } });
    if (!existing) {
      return reply.code(404).send({ error: 'Ticket not found' });
    }

    const ticket = await prisma.ticket.update({
      where: { id },
      data: { priority },
    });

    return ticket;
  });

  app.get('/:id', {
    preHandler: async (request) => { await request.jwtVerify(); },
    schema: {
      summary: 'Get support ticket by id',
      tags: ['Tickets'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      response: {
        200: { $ref: 'Ticket#' },
        404: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    await closeExpiredResolvedTickets();
    const { id } = request.params as { id: string };
    const item = await prisma.ticket.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: 'Ticket not found' });

    const hasUnreadUserMessage = Boolean(
      item.lastUserMessageAt
      && (!item.lastReadByAdminAt || item.lastUserMessageAt > item.lastReadByAdminAt),
    );

    return { ...item, hasUnreadUserMessage };
  });

  app.get('/:id/messages', {
    preHandler: async (request) => { await request.jwtVerify(); },
    schema: {
      summary: 'List ticket messages',
      tags: ['Tickets'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  }, async (request, reply) => {
    await closeExpiredResolvedTickets();
    const { id } = request.params as { id: string };
    const existing = await prisma.ticket.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Ticket not found' });

    const items = await prisma.ticketMessage.findMany({
      where: { ticketId: id },
      orderBy: [{ createdAt: 'asc' }],
    });

    await prisma.ticket.update({
      where: { id },
      data: { lastReadByAdminAt: new Date() },
    });

    return { items };
  });

  app.post('/:id/messages', {
    preHandler: async (request) => { await request.jwtVerify(); },
    schema: {
      summary: 'Create ticket message (admin)',
      tags: ['Tickets'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      body: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          attachment: {
            type: 'object',
            nullable: true,
            properties: {
              name: { type: 'string' },
              mimeType: { type: 'string' },
              sizeBytes: { type: 'number' },
              base64: { type: 'string' },
            },
          },
        },
        required: ['message'],
      },
    },
  }, async (request, reply) => {
    await closeExpiredResolvedTickets();
    const { id } = request.params as { id: string };
    const body = request.body as {
      message?: string;
      attachment?: { name?: string; mimeType?: string; sizeBytes?: number; base64?: string } | null;
    };
    const message = normalizeMessage(body?.message);
    const attachment = normalizeAttachment(body?.attachment);

    if (!message) {
      return reply.code(400).send({ error: 'Validation failed', fields: { message: 'Mensagem é obrigatória' } });
    }
    if (body?.attachment && !attachment) {
      return reply.code(400).send({ error: 'Validation failed', fields: { attachment: 'Anexo inválido (máx. 5MB)' } });
    }

    const ticket = await prisma.ticket.findUnique({ where: { id } });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });
    if (ticket.status === TicketStatus.CLOSED) {
      return reply.code(409).send({ error: 'Ticket is closed and does not accept new messages' });
    }

    let attachmentPayload: {
      attachmentName: string;
      attachmentMimeType: string;
      attachmentSizeBytes: number;
      attachmentObjectName: string;
    } | null = null;

    if (attachment) {
      const safeFileName = sanitizeFileName(attachment.name || 'anexo');
      const buffer = decodeBase64(attachment.base64);
      if (!buffer || buffer.length === 0 || buffer.length > maxAttachmentBytes) {
        return reply.code(400).send({ error: 'Validation failed', fields: { attachment: 'Arquivo inválido (máx. 5MB)' } });
      }

      const objectName = `tickets/${String(ticket.branchId || 'no-branch')}/${id}/${Date.now()}_${makeObjectSuffix()}_${safeFileName}`;
      await getAnexosStorage().save(objectName, buffer, {
        contentType: attachment.mimeType || 'application/octet-stream',
        metadata: {
          ticketId: id,
          uploadedByUserId: String((request.user as any)?.id || ''),
          scope: 'ticket-message-admin',
        },
      });

      attachmentPayload = {
        attachmentName: safeFileName,
        attachmentMimeType: attachment.mimeType || 'application/octet-stream',
        attachmentSizeBytes: buffer.length,
        attachmentObjectName: objectName,
      };
    }

    const actorId = String((request.user as any)?.id || '');
    const isAdmHubOnly = Boolean((request.user as any)?.admHubOnly);
    let authorName: string | null = null;
    let authorEmail: string | null = null;

    if (isAdmHubOnly && actorId) {
      const admin = await prisma.adminUser.findUnique({ where: { id: actorId } });
      authorName = admin?.name || 'Administrador';
      authorEmail = admin?.email || null;
    } else if (actorId) {
      const user = await prisma.user.findUnique({ where: { id: actorId } });
      authorName = user?.name || 'Administrador';
      authorEmail = user?.email || null;
    }

    const item = await prisma.ticketMessage.create({
      data: {
        ticketId: id,
        authorRole: 'ADMIN',
        authorUserId: actorId || null,
        authorName,
        authorEmail,
        message,
        attachmentName: attachmentPayload?.attachmentName || null,
        attachmentMimeType: attachmentPayload?.attachmentMimeType || null,
        attachmentSizeBytes: attachmentPayload?.attachmentSizeBytes || null,
        attachmentObjectName: attachmentPayload?.attachmentObjectName || null,
      },
    });

    await prisma.ticket.update({
      where: { id },
      data: {
        updatedAt: new Date(),
        lastAdminMessageAt: new Date(),
        lastReadByAdminAt: new Date(),
      },
    });

    return reply.code(201).send(item);
  });

  app.get('/messages/:messageId/attachment/view', {
    preHandler: async (request) => { await request.jwtVerify(); },
    schema: {
      summary: 'View ticket message attachment (admin)',
      tags: ['Tickets'],
      params: {
        type: 'object',
        properties: { messageId: { type: 'string' } },
        required: ['messageId'],
      },
    },
  }, async (request, reply) => {
    const { messageId } = request.params as { messageId: string };
    const message = await prisma.ticketMessage.findUnique({
      where: { id: messageId },
      include: { ticket: true },
    });

    if (!message || !message.ticket) return reply.code(404).send({ error: 'Attachment not found' });
    if (!message.attachmentObjectName) return reply.code(404).send({ error: 'Attachment not found' });

    const storage = getAnexosStorage();
    const exists = await storage.exists(message.attachmentObjectName);
    if (!exists) return reply.code(404).send({ error: 'Arquivo não encontrado no storage' });

    reply.header('Content-Type', message.attachmentMimeType || 'application/octet-stream');
    reply.header('Content-Disposition', `inline; filename="${message.attachmentName || 'anexo'}"`);
    return reply.send(storage.createReadStream(message.attachmentObjectName));
  });
}
