import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';
import bcrypt from 'bcryptjs';

export default async function userRoutes(app: FastifyInstance) {
  const isRoomSector = (sector: { name?: string | null; description?: string | null }) => {
    const name = String(sector?.name || '').trim().toLowerCase();
    const description = String(sector?.description || '').trim().toLowerCase();
    if (description.startsWith('[sala]') || description.startsWith('__room__')) return true;
    return /^sala(\s|$|\d)/i.test(name) || name.startsWith('room ');
  };

  const userInclude = {
    sector: {
      include: {
        branch: {
          include: {
            company: true,
          },
        },
      },
    },
    accesses: {
      include: {
        modules: true,
      },
    },
  };

  const getLoggedContext = async (requestUserId: string) => {
    const loggedUser = await prisma.user.findUnique({
      where: { id: requestUserId },
      include: { sector: { include: { branch: true } } },
    });

    const branch = loggedUser?.sector?.branch;
    if (!branch?.companyId || !branch?.id) return null;

    return {
      companyId: branch.companyId,
      branchId: branch.id,
    };
  };

  // List all users
  app.get('/users', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'List all users',
      tags: ['Users'],
      security: [{ bearerAuth: [] }],
      // response: { 200: { type: 'array', items: { $ref: 'User#' } }, 403: { type: 'object' } },
    },
  }, async (request, reply) => {
    // Get logged user's company ID
    const userId = (request.user as any).id;
    const loggedContext = await getLoggedContext(userId);

    if (!loggedContext?.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }
    
    // Return only users from same company
    const users = await prisma.user.findMany({
      where: {
        sector: {
          branch: {
            companyId: loggedContext.companyId,
          },
        },
      },
      include: userInclude,
    });
    return users;
  });

  // Create a new user
  app.post('/users', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Create user',
      tags: ['Users'],
      security: [{ bearerAuth: [] }],
      body: { $ref: 'UserCreate#' },
      // response: { 200: { $ref: 'User#' } },
    },
  }, async (request, reply) => {
    const { branchId, sectorId, accessIds, name, birthDate, email, password, phone, address } = request.body as {
      branchId: string;
      sectorId: string;
      accessIds: string[];
      name: string;
      birthDate: string;
      email: string;
      password: string;
      phone: string;
      address: string;
    };

    const requestUserId = (request.user as any).id as string;
    const loggedContext = await getLoggedContext(requestUserId);

    if (!loggedContext?.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    if (!branchId) {
      return reply.code(400).send({ error: 'Filial é obrigatória' });
    }

    const branch = await prisma.branch.findFirst({
      where: {
        id: branchId,
        companyId: loggedContext.companyId,
      },
    });

    if (!branch) {
      return reply.code(403).send({ error: 'Filial inválida para sua empresa' });
    }

    const sector = await prisma.sector.findFirst({
      where: {
        id: sectorId,
        branchId,
      },
    });

    if (!sector) {
      return reply.code(400).send({ error: 'Setor inválido para a filial informada' });
    }

    if (isRoomSector(sector)) {
      return reply.code(400).send({ error: 'Não é permitido vincular usuário a uma sala' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        sectorId,
        accesses: { connect: accessIds.map((id) => ({ id })) },
        name,
        birthDate: new Date(birthDate),
        email,
        password: hashedPassword,
        phone,
        address,
      },
      include: userInclude,
    });
    return user;
  });

  // Get a user by ID
  app.get('/users/:id', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Get user by ID',
      tags: ['Users'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const requestUserId = (request.user as any).id as string;
    const loggedContext = await getLoggedContext(requestUserId);

    if (!loggedContext?.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    const user = await prisma.user.findUnique({
      where: { id },
      include: userInclude,
    });
    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }

    if (user.sector?.branch?.companyId !== loggedContext.companyId) {
      return reply.code(403).send({ error: 'User outside of your company scope' });
    }

    return user;
  });

  // Update a user by ID
  app.put('/users/:id', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Update user',
      tags: ['Users'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { $ref: 'UserUpdate#' },
      // response: { 200: { $ref: 'User#' }, 404: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { branchId, sectorId, accessIds, name, birthDate, email, password, phone, address } = request.body as {
      branchId?: string;
      sectorId?: string;
      accessIds?: string[];
      name?: string;
      birthDate?: string;
      email?: string;
      password?: string;
      phone?: string;
      address?: string;
    };

    const requestUserId = (request.user as any).id as string;
    const loggedContext = await getLoggedContext(requestUserId);

    if (!loggedContext?.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    try {
      const existingUser = await prisma.user.findUnique({
        where: { id },
        include: {
          sector: {
            include: {
              branch: true,
            },
          },
        },
      });

      if (!existingUser) {
        return reply.code(404).send({ error: 'User not found' });
      }

      if (existingUser.sector?.branch?.companyId !== loggedContext.companyId) {
        return reply.code(403).send({ error: 'User outside of your company scope' });
      }

      if (branchId && !sectorId) {
        return reply.code(400).send({ error: 'Ao alterar filial, informe também o setor' });
      }

      let validatedSectorId: string | undefined = sectorId;
      if (sectorId) {
        const sector = await prisma.sector.findUnique({
          where: { id: sectorId },
          include: { branch: true },
        });

        if (!sector || sector.branch.companyId !== loggedContext.companyId) {
          return reply.code(400).send({ error: 'Setor inválido para sua empresa' });
        }

        if (branchId && sector.branchId !== branchId) {
          return reply.code(400).send({ error: 'Setor não pertence à filial informada' });
        }

        if (isRoomSector(sector)) {
          return reply.code(400).send({ error: 'Não é permitido vincular usuário a uma sala' });
        }

        validatedSectorId = sector.id;
      }

      const data: any = {
        sectorId: validatedSectorId,
        accesses: accessIds ? { set: accessIds.map((accessId) => ({ id: accessId })) } : undefined,
        name,
        birthDate: birthDate ? new Date(birthDate) : undefined,
        email,
        phone,
        address,
      };
      if (password) {
        data.password = await bcrypt.hash(password, 10);
      }
      const user = await prisma.user.update({
        where: { id },
        data,
        include: userInclude,
      });
      return user;
    } catch (error) {
      return reply.code(404).send({ error: 'User not found or invalid data' });
    }
  });

  // Delete a user by ID
  app.delete('/users/:id', {
    preHandler: async (request, reply) => { await request.jwtVerify(); },
    schema: {
      summary: 'Delete user',
      tags: ['Users'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: {
        200: { type: 'object', example: { message: 'User deleted' } },
        403: { type: 'object' },
        404: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const requestUserId = (request.user as any).id as string;
    const loggedContext = await getLoggedContext(requestUserId);

    if (!loggedContext?.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }

    try {
      const existingUser = await prisma.user.findUnique({
        where: { id },
        include: {
          sector: {
            include: {
              branch: true,
            },
          },
        },
      });

      if (!existingUser) {
        return reply.code(404).send({ error: 'User not found' });
      }

      if (existingUser.sector?.branch?.companyId !== loggedContext.companyId) {
        return reply.code(403).send({ error: 'User outside of your company scope' });
      }

      await prisma.user.delete({
        where: { id },
      });
      return { message: 'User deleted' };
    } catch (error) {
      return reply.code(404).send({ error: 'User not found' });
    }
  });
}
