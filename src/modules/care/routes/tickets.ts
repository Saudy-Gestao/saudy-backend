import { randomBytes } from 'crypto';
import { FastifyInstance } from 'fastify';
import { TicketType, TicketStatus } from '@prisma/client';
import prisma from '../lib/prisma';
import { getAnexosStorage } from '../../../lib/storage';

const ticketTypeValues = ['BUG', 'ERROR', 'IMPROVEMENT'] as const;
const ticketStatusValues = ['OPEN', 'TRIAGE', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
const maxAttachmentBytes = 5 * 1024 * 1024;

function normalizeRequiredString(value: unknown) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeType(value: unknown): TicketType | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return ticketTypeValues.includes(normalized as TicketType) ? (normalized as TicketType) : null;
}

function normalizeStatus(value: unknown): TicketStatus | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return ticketStatusValues.includes(normalized as TicketStatus) ? (normalized as TicketStatus) : null;
}

function normalizeOptionalString(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
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

  app.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  app.post('/', {
    schema: {
      summary: 'Create support ticket',
      tags: ['Tickets'],
      body: {
        type: 'object',
        properties: {
          flow: { type: 'string' },
          module: { type: 'string' },
          type: { type: 'string', enum: ['BUG', 'ERROR', 'IMPROVEMENT'] },
          description: { type: 'string' },
        },
        required: ['flow', 'module', 'type', 'description'],
      },
      response: {
        201: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            flow: { type: 'string' },
            module: { type: 'string' },
            type: { type: 'string', enum: ['BUG', 'ERROR', 'IMPROVEMENT'] },
            description: { type: 'string' },
            status: { type: 'string', enum: ['OPEN', 'TRIAGE', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] },
            priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
            createdByUserId: { type: 'string', nullable: true },
            createdByName: { type: 'string', nullable: true },
            createdByEmail: { type: 'string', nullable: true },
            branchId: { type: 'string', nullable: true },
            branchName: { type: 'string', nullable: true },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        400: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      flow?: string;
      module?: string;
      type?: string;
      description?: string;
    };

    const flow = normalizeRequiredString(body?.flow);
    const module = normalizeRequiredString(body?.module);
    const type = normalizeType(body?.type);
    const description = normalizeRequiredString(body?.description);

    const fieldErrors: Record<string, string> = {};
    if (!flow) fieldErrors.flow = 'Fluxo é obrigatório';
    if (!module) fieldErrors.module = 'Módulo é obrigatório';
    if (!type) fieldErrors.type = 'Tipo inválido';
    if (!description) fieldErrors.description = 'Descrição é obrigatória';
    else if (description.length < 10) fieldErrors.description = 'Descrição deve ter ao menos 10 caracteres';

    if (Object.keys(fieldErrors).length > 0) {
      return reply.code(400).send({ error: 'Validation failed', fields: fieldErrors });
    }

    const userId = String((request.user as any)?.id || '');
    let createdByName: string | null = null;
    let createdByEmail: string | null = null;
    let branchId: string | null = null;
    let branchName: string | null = null;

    if (userId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { sector: { include: { branch: true } } },
      });

      createdByName = user?.name || null;
      createdByEmail = user?.email || null;
      branchId = user?.sector?.branch?.id || null;
      branchName = user?.sector?.branch?.tradeName || user?.sector?.branch?.name || null;
    }

    const ticket = await prisma.ticket.create({
      data: {
        flow,
        module,
        type,
        description,
        status: TicketStatus.OPEN,
        createdByUserId: userId || null,
        createdByName,
        createdByEmail,
        branchId,
        branchName,
        lastUserMessageAt: new Date(),
        lastReadByUserAt: new Date(),
      },
    });

    return reply.code(201).send(ticket);
  });

  app.get('/mine', {
    schema: {
      summary: 'List current user tickets',
      tags: ['Tickets'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          status: { type: 'string', enum: ['ALL', ...ticketStatusValues] },
          type: { type: 'string', enum: ['ALL', ...ticketTypeValues] },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  flow: { type: 'string' },
                  module: { type: 'string' },
                  type: { type: 'string', enum: ['BUG', 'ERROR', 'IMPROVEMENT'] },
                  description: { type: 'string' },
                  status: { type: 'string', enum: ['OPEN', 'TRIAGE', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] },
                  priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
                  createdAt: { type: 'string', format: 'date-time' },
                  updatedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
            total: { type: 'number' },
            limit: { type: 'number' },
            offset: { type: 'number' },
          },
        },
      },
    },
  }, async (request) => {
    await closeExpiredResolvedTickets();
    const userId = String((request.user as any)?.id || '');
    if (!userId) return { items: [], total: 0, limit: 50, offset: 0 };

    const { search, status, type, limit = 50, offset = 0 } = request.query as {
      search?: string;
      status?: TicketStatus | 'ALL';
      type?: TicketType | 'ALL';
      limit?: number;
      offset?: number;
    };

    const where: any = { createdByUserId: userId };
    const normalizedSearch = normalizeOptionalString(search);

    if (normalizedSearch) {
      where.OR = [
        { flow: { contains: normalizedSearch, mode: 'insensitive' } },
        { module: { contains: normalizedSearch, mode: 'insensitive' } },
        { description: { contains: normalizedSearch, mode: 'insensitive' } },
      ];
    }

    if (status && status !== 'ALL') {
      const normalizedStatus = normalizeStatus(status);
      if (normalizedStatus) where.status = normalizedStatus;
    }

    if (type && type !== 'ALL') {
      const normalizedType = normalizeType(type);
      if (normalizedType) where.type = normalizedType;
    }

    const take = Number.isFinite(Number(limit)) ? Number(limit) : 50;
    const skip = Number.isFinite(Number(offset)) ? Number(offset) : 0;

    const [rows, total] = await Promise.all([
      prisma.ticket.findMany({
        where,
        take,
        skip,
        orderBy: [{ createdAt: 'desc' }],
      }),
      prisma.ticket.count({ where }),
    ]);

    const items = rows.map((item: any) => {
      const hasUnreadAdminMessage = Boolean(
        item.lastAdminMessageAt
        && (!item.lastReadByUserAt || item.lastAdminMessageAt > item.lastReadByUserAt),
      );

      return {
        ...item,
        hasUnreadAdminMessage,
      };
    });

    const unreadCount = items.filter((item: any) => item.hasUnreadAdminMessage).length;

    return { items, total, unreadCount, limit: take, offset: skip };
  });

  app.get('/:id', {
    schema: {
      summary: 'Get current user ticket by id',
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
    const userId = String((request.user as any)?.id || '');
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const item = await prisma.ticket.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: 'Ticket not found' });
    if (item.createdByUserId !== userId) return reply.code(403).send({ error: 'Forbidden' });

    const hasUnreadAdminMessage = Boolean(
      item.lastAdminMessageAt
      && (!item.lastReadByUserAt || item.lastAdminMessageAt > item.lastReadByUserAt),
    );

    return { ...item, hasUnreadAdminMessage };
  });

  app.get('/:id/messages', {
    schema: {
      summary: 'List current user ticket messages',
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
    const userId = String((request.user as any)?.id || '');
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const ticket = await prisma.ticket.findUnique({ where: { id } });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });
    if (ticket.createdByUserId !== userId) return reply.code(403).send({ error: 'Forbidden' });
    if (ticket.status === TicketStatus.CLOSED) {
      return reply.code(409).send({ error: 'Ticket is closed and does not accept new messages' });
    }

    const items = await prisma.ticketMessage.findMany({
      where: { ticketId: id },
      orderBy: [{ createdAt: 'asc' }],
    });

    await prisma.ticket.update({
      where: { id },
      data: { lastReadByUserAt: new Date() },
    });

    return { items };
  });

  app.post('/:id/messages', {
    schema: {
      summary: 'Create current user ticket message',
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
    const { id } = request.params as { id: string };
    const body = request.body as {
      message?: string;
      attachment?: { name?: string; mimeType?: string; sizeBytes?: number; base64?: string } | null;
    };
    const message = normalizeMessage(body?.message);
    if (!message) {
      return reply.code(400).send({ error: 'Validation failed', fields: { message: 'Mensagem é obrigatória' } });
    }
    const attachment = normalizeAttachment(body?.attachment);
    if (body?.attachment && !attachment) {
      return reply.code(400).send({ error: 'Validation failed', fields: { attachment: 'Anexo inválido (máx. 5MB)' } });
    }

    const userId = String((request.user as any)?.id || '');
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const ticket = await prisma.ticket.findUnique({ where: { id } });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });
    if (ticket.createdByUserId !== userId) return reply.code(403).send({ error: 'Forbidden' });

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
          uploadedByUserId: userId,
          scope: 'ticket-message-user',
        },
      });

      attachmentPayload = {
        attachmentName: safeFileName,
        attachmentMimeType: attachment.mimeType || 'application/octet-stream',
        attachmentSizeBytes: buffer.length,
        attachmentObjectName: objectName,
      };
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    const item = await prisma.ticketMessage.create({
      data: {
        ticketId: id,
        authorRole: 'USER',
        authorUserId: userId,
        authorName: user?.name || null,
        authorEmail: user?.email || null,
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
        lastUserMessageAt: new Date(),
        lastReadByUserAt: new Date(),
      },
    });

    return reply.code(201).send(item);
  });

  app.post('/:id/confirm-close', {
    schema: {
      summary: 'Confirm ticket close by current user',
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
    const userId = String((request.user as any)?.id || '');
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const ticket = await prisma.ticket.findUnique({ where: { id } });
    if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });
    if (ticket.createdByUserId !== userId) return reply.code(403).send({ error: 'Forbidden' });
    if (ticket.status !== TicketStatus.RESOLVED) {
      return reply.code(400).send({ error: 'Ticket is not awaiting confirmation' });
    }

    const now = new Date();
    const updated = await prisma.ticket.update({
      where: { id },
      data: {
        status: TicketStatus.CLOSED,
        resolutionConfirmedAt: now,
      },
    });

    await prisma.ticketMessage.create({
      data: {
        ticketId: id,
        authorRole: 'SYSTEM',
        authorName: 'Sistema',
        message: 'O solicitante confirmou a resolução. Ticket fechado automaticamente.',
      },
    });

    return updated;
  });

  app.get('/messages/:messageId/attachment/view', {
    schema: {
      summary: 'View current user ticket message attachment',
      tags: ['Tickets'],
      params: {
        type: 'object',
        properties: { messageId: { type: 'string' } },
        required: ['messageId'],
      },
    },
  }, async (request, reply) => {
    const { messageId } = request.params as { messageId: string };
    const userId = String((request.user as any)?.id || '');
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const message = await prisma.ticketMessage.findUnique({
      where: { id: messageId },
      include: { ticket: true },
    });

    if (!message || !message.ticket) return reply.code(404).send({ error: 'Attachment not found' });
    if (message.ticket.createdByUserId !== userId) return reply.code(403).send({ error: 'Forbidden' });
    if (!message.attachmentObjectName) return reply.code(404).send({ error: 'Attachment not found' });

    const storage = getAnexosStorage();
    const exists = await storage.exists(message.attachmentObjectName);
    if (!exists) return reply.code(404).send({ error: 'Arquivo não encontrado no storage' });

    reply.header('Content-Type', message.attachmentMimeType || 'application/octet-stream');
    reply.header('Content-Disposition', `inline; filename="${message.attachmentName || 'anexo'}"`);
    return reply.send(storage.createReadStream(message.attachmentObjectName));
  });
}
