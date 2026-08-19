import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function sectorRoutes(app: FastifyInstance) {
  const normalizeWeekday = (value?: string | null) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
  const VALID_WEEKDAYS = new Set(['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']);
  const normalizeWorkingDays = (days: any): string[] => {
    if (!Array.isArray(days)) return [];
    return Array.from(new Set(
      days
        .map((value) => normalizeWeekday(value))
        .filter((value) => VALID_WEEKDAYS.has(value)),
    ));
  };
  const normalizeTime = (value?: string | null): string | null => {
    const raw = String(value || '').trim();
    if (!raw) return null;
    return /^\d{2}:\d{2}$/.test(raw) ? raw : null;
  };

  const getLoggedContext = async (userId: string) => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });

    const branch = user?.sector?.branch;
    if (!branch?.companyId || !branch?.id) return null;
    return {
      companyId: branch.companyId,
      branchId: branch.id,
    };
  };

  // List all sectors
  app.get('/sectors', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'List all sectors',
      tags: ['Sectors'],
      security: [{ bearerAuth: [] }],
      response: { 200: { type: 'array', items: { $ref: 'Sector#' } }, 403: { type: 'object' } },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).id;
    const loggedContext = await getLoggedContext(userId);

    if (!loggedContext?.companyId || !loggedContext?.branchId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    const companyBranches = await prisma.branch.findMany({
      where: { companyId: loggedContext.companyId },
      select: { id: true },
    });

    const sectors = await prisma.sector.findMany({
      where: {
        branchId: {
          in: companyBranches.map((branch: { id: string }) => branch.id),
        },
      },
      include: { branch: true },
    });
    return sectors;
  });

  // Create a new sector
  app.post('/sectors', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Create sector',
      tags: ['Sectors'],
      security: [{ bearerAuth: [] }],
      body: { $ref: 'SectorCreate#' },
      response: { 200: { $ref: 'Sector#' }, 400: { type: 'object' }, 403: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { branchId, name, description, workingDays, workingHoursStart, workingHoursEnd, modalidadeId, especialidadeId, capacity } = request.body as {
      branchId: string;
      name: string;
      description: string;
      workingDays?: string[];
      workingHoursStart?: string;
      workingHoursEnd?: string;
      modalidadeId?: string | null;
      especialidadeId?: string | null;
      capacity?: number | null;
    };

    const userId = (request.user as any).id;
    const loggedContext = await getLoggedContext(userId);

    if (!loggedContext?.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    const targetBranchId = String(branchId || '').trim();
    if (!targetBranchId) {
      return reply.code(400).send({ error: 'Filial é obrigatória' });
    }

    const branch = await prisma.branch.findFirst({
      where: {
        id: targetBranchId,
        companyId: loggedContext.companyId,
      },
      select: { id: true },
    });

    if (!branch) {
      return reply.code(403).send({ error: 'Filial inválida para sua empresa' });
    }

    const normalizedWorkingDays = normalizeWorkingDays(workingDays);
    const normalizedWorkingHoursStart = normalizeTime(workingHoursStart);
    const normalizedWorkingHoursEnd = normalizeTime(workingHoursEnd);
    if ((workingHoursStart && !normalizedWorkingHoursStart) || (workingHoursEnd && !normalizedWorkingHoursEnd)) {
      return reply.code(400).send({ error: 'Horário de funcionamento deve estar no formato HH:mm' });
    }
    if ((normalizedWorkingHoursStart && !normalizedWorkingHoursEnd) || (!normalizedWorkingHoursStart && normalizedWorkingHoursEnd)) {
      return reply.code(400).send({ error: 'Informe hora inicial e final do funcionamento da sala' });
    }
    if (normalizedWorkingHoursStart && normalizedWorkingHoursEnd && normalizedWorkingHoursEnd <= normalizedWorkingHoursStart) {
      return reply.code(400).send({ error: 'Hora final da sala deve ser maior que a inicial' });
    }

    let resolvedEspecialidadeId: string | null = null;
    if (especialidadeId) {
      const especialidade = await prisma.especialidade.findUnique({ where: { id: especialidadeId } });
      if (!especialidade || (modalidadeId && especialidade.modalidadeId !== modalidadeId)) {
        return reply.code(400).send({ error: 'Especialidade inválida para a modalidade selecionada' });
      }
      resolvedEspecialidadeId = especialidade.id;
    }

    const normalizedCapacity = capacity !== undefined && capacity !== null ? Number(capacity) : null;
    if (normalizedCapacity !== null && (!Number.isInteger(normalizedCapacity) || normalizedCapacity < 1)) {
      return reply.code(400).send({ error: 'Capacidade de slots deve ser um número inteiro maior que zero' });
    }

    const sector = await prisma.sector.create({
      data: {
        branchId: targetBranchId,
        name,
        description,
        workingDays: normalizedWorkingDays,
        workingHoursStart: normalizedWorkingHoursStart,
        workingHoursEnd: normalizedWorkingHoursEnd,
        modalidadeId: modalidadeId || null,
        especialidadeId: resolvedEspecialidadeId,
        capacity: normalizedCapacity,
      },
    });
    return sector;
  });

  // Get a sector by ID
  app.get('/sectors/:id', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Get sector by ID',
      tags: ['Sectors'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: { 200: { type: 'object', additionalProperties: true }, 403: { type: 'object' }, 404: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = (request.user as any).id;
    const loggedContext = await getLoggedContext(userId);

    if (!loggedContext?.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    const sector = await prisma.sector.findUnique({
      where: { id },
      include: { branch: true },
    });
    if (!sector) {
      return reply.code(404).send({ error: 'Sector not found' });
    }
    if (sector.branch?.companyId !== loggedContext.companyId) {
      return reply.code(403).send({ error: 'Setor fora da sua empresa' });
    }
    return sector;
  });

  // Update a sector by ID
  app.put('/sectors/:id', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Update sector',
      tags: ['Sectors'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object' },
      response: { 200: { type: 'object', additionalProperties: true }, 400: { type: 'object' }, 403: { type: 'object' }, 404: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { branchId, name, description, workingDays, workingHoursStart, workingHoursEnd, modalidadeId, especialidadeId, capacity } = request.body as {
      branchId?: string;
      name?: string;
      description?: string;
      workingDays?: string[];
      workingHoursStart?: string;
      workingHoursEnd?: string;
      modalidadeId?: string | null;
      especialidadeId?: string | null;
      capacity?: number | null;
    };

    const userId = (request.user as any).id;
    const loggedContext = await getLoggedContext(userId);

    if (!loggedContext?.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    try {
      const current = await prisma.sector.findUnique({
        where: { id },
        include: { branch: true },
      });
      if (!current) {
        return reply.code(404).send({ error: 'Sector not found' });
      }
      if (current.branch?.companyId !== loggedContext.companyId) {
        return reply.code(403).send({ error: 'Setor fora da sua empresa' });
      }

      let resolvedBranchId = current.branchId;
      if (branchId) {
        const targetBranch = await prisma.branch.findFirst({
          where: {
            id: branchId,
            companyId: loggedContext.companyId,
          },
          select: { id: true },
        });

        if (!targetBranch) {
          return reply.code(403).send({ error: 'Você só pode mover setor para uma filial da sua empresa' });
        }

        resolvedBranchId = targetBranch.id;
      }

      const normalizedWorkingDays = workingDays !== undefined ? normalizeWorkingDays(workingDays) : undefined;
      const normalizedWorkingHoursStart = workingHoursStart !== undefined ? normalizeTime(workingHoursStart) : undefined;
      const normalizedWorkingHoursEnd = workingHoursEnd !== undefined ? normalizeTime(workingHoursEnd) : undefined;
      if ((workingHoursStart !== undefined && !normalizedWorkingHoursStart && String(workingHoursStart || '').trim())
        || (workingHoursEnd !== undefined && !normalizedWorkingHoursEnd && String(workingHoursEnd || '').trim())) {
        return reply.code(400).send({ error: 'Horário de funcionamento deve estar no formato HH:mm' });
      }
      const resolvedStart = normalizedWorkingHoursStart !== undefined ? normalizedWorkingHoursStart : current.workingHoursStart;
      const resolvedEnd = normalizedWorkingHoursEnd !== undefined ? normalizedWorkingHoursEnd : current.workingHoursEnd;
      if ((resolvedStart && !resolvedEnd) || (!resolvedStart && resolvedEnd)) {
        return reply.code(400).send({ error: 'Informe hora inicial e final do funcionamento da sala' });
      }
      if (resolvedStart && resolvedEnd && resolvedEnd <= resolvedStart) {
        return reply.code(400).send({ error: 'Hora final da sala deve ser maior que a inicial' });
      }

      let resolvedEspecialidadeId: string | null | undefined;
      if (especialidadeId !== undefined) {
        if (especialidadeId) {
          const targetModalidadeId = modalidadeId !== undefined ? modalidadeId : current.modalidadeId;
          const especialidade = await prisma.especialidade.findUnique({ where: { id: especialidadeId } });
          if (!especialidade || (targetModalidadeId && especialidade.modalidadeId !== targetModalidadeId)) {
            return reply.code(400).send({ error: 'Especialidade inválida para a modalidade selecionada' });
          }
          resolvedEspecialidadeId = especialidade.id;
        } else {
          resolvedEspecialidadeId = null;
        }
      }

      let normalizedCapacity: number | null | undefined;
      if (capacity !== undefined) {
        normalizedCapacity = capacity === null ? null : Number(capacity);
        if (normalizedCapacity !== null && (!Number.isInteger(normalizedCapacity) || normalizedCapacity < 1)) {
          return reply.code(400).send({ error: 'Capacidade de slots deve ser um número inteiro maior que zero' });
        }
      }

      const sector = await prisma.sector.update({
        where: { id },
        data: {
          branchId: resolvedBranchId,
          name,
          description,
          ...(normalizedWorkingDays !== undefined ? { workingDays: normalizedWorkingDays } : {}),
          ...(normalizedWorkingHoursStart !== undefined ? { workingHoursStart: normalizedWorkingHoursStart } : {}),
          ...(normalizedWorkingHoursEnd !== undefined ? { workingHoursEnd: normalizedWorkingHoursEnd } : {}),
          ...(modalidadeId !== undefined ? { modalidadeId: modalidadeId || null } : {}),
          ...(resolvedEspecialidadeId !== undefined ? { especialidadeId: resolvedEspecialidadeId } : {}),
          ...(normalizedCapacity !== undefined ? { capacity: normalizedCapacity } : {}),
        },
      });
      return sector;
    } catch (error) {
      return reply.code(404).send({ error: 'Sector not found or invalid data' });
    }
  });

  // Delete a sector by ID
  app.delete('/sectors/:id', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Delete sector',
      tags: ['Sectors'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: { 200: { type: 'object' }, 403: { type: 'object' }, 404: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = (request.user as any).id;
    const loggedContext = await getLoggedContext(userId);

    if (!loggedContext?.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    try {
      const current = await prisma.sector.findUnique({
        where: { id },
        include: { branch: true },
      });
      if (!current) {
        return reply.code(404).send({ error: 'Sector not found' });
      }
      if (current.branch?.companyId !== loggedContext.companyId) {
        return reply.code(403).send({ error: 'Setor fora da sua empresa' });
      }

      await prisma.sector.delete({
        where: { id },
      });
      return { message: 'Sector deleted' };
    } catch (error) {
      return reply.code(404).send({ error: 'Sector not found' });
    }
  });
}
