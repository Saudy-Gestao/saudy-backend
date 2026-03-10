import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';
import bcrypt from 'bcryptjs';

export default async function userRoutes(app: FastifyInstance) {
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
    const loggedUser = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });
    
    if (!loggedUser?.sector?.branch?.companyId) {
      return reply.code(403).send({ error: 'User not associated with a company' });
    }
    
    // Return only users from same company
    const users = await prisma.user.findMany({
      where: {
        sector: {
          branch: {
            companyId: loggedUser.sector.branch.companyId
          }
        }
      },
      include: { 
        sector: {
          include: {
            branch: {
              include: {
                company: true
              }
            }
          }
        }, 
        accesses: {
          include: {
            modules: true  // Incluir módulos
          }
        }
      },
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
    const { sectorId, accessIds, name, birthDate, email, password, phone, address } = request.body as {
      sectorId: string;
      accessIds: string[];
      name: string;
      birthDate: string;
      email: string;
      password: string;
      phone: string;
      address: string;
    };
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { sectorId, accesses: { connect: accessIds.map(id => ({ id })) }, name, birthDate: new Date(birthDate), email: normalizedEmail, password: hashedPassword, phone, address },
      include: {
        sector: {
          include: {
            branch: {
              include: {
                company: true
              }
            }
          }
        },
        accesses: {
          include: {
            modules: true
          }
        }
      },
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
    const user = await prisma.user.findUnique({
      where: { id },
      include: { 
        sector: {
          include: {
            branch: {
              include: {
                company: true
              }
            }
          }
        }, 
        accesses: {
          include: {
            modules: true  // Incluir módulos
          }
        }
      },
    });
    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
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
    const { sectorId, accessIds, name, birthDate, email, password, phone, address } = request.body as {
      sectorId?: string;
      accessIds?: string[];
      name?: string;
      birthDate?: string;
      email?: string;
      password?: string;
      phone?: string;
      address?: string;
    };
    try {
      const normalizedEmail = email ? String(email).trim().toLowerCase() : undefined;
      const data: any = {
        sectorId,
        accesses: accessIds ? { set: accessIds.map(id => ({ id })) } : undefined,
        name,
        birthDate: birthDate ? new Date(birthDate) : undefined,
        email: normalizedEmail,
        phone,
        address,
      };
      if (password) {
        data.password = await bcrypt.hash(password, 10);
      }
      const user = await prisma.user.update({
        where: { id },
        data,
        include: {
          sector: {
            include: {
              branch: {
                include: {
                  company: true
                }
              }
            }
          },
          accesses: {
            include: {
              modules: true
            }
          }
        },
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
      response: { 200: { type: 'object', example: { message: 'User deleted' } }, 404: { type: 'object' } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await prisma.user.delete({
        where: { id },
      });
      return { message: 'User deleted' };
    } catch (error) {
      return reply.code(404).send({ error: 'User not found' });
    }
  });
}