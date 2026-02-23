import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { sendPasswordResetCodeEmail } from '../lib/mailer';

const RESET_CODE_EXPIRATION_MINUTES = 10;

function hashResetCode(code: string) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function generateResetCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function normalizeIdentifier(value: string) {
  return value.trim();
}

function isEmail(value: string) {
  return value.includes('@');
}

function digitsOnly(value: string) {
  return value.replace(/\D/g, '');
}

function validateStrongPassword(password: string) {
  const minLength = password.length >= 8;
  const hasNumber = /\d/.test(password);
  const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(password);

  return minLength && hasNumber && hasSpecial;
}

export default async function authRoutes(app: FastifyInstance) {
  // Register complete setup
  app.post('/register', {
    schema: {
      summary: 'Register a complete company/branch/sector/user setup',
      tags: ['Auth'],
      body: { $ref: 'RegisterRequest#' },
      response: { 200: { $ref: 'RegisterResponse#' }, 400: { type: 'object' } },
    },
  }, async (request, reply) => {
    const {
      company,
      branch,
      sector,
      user,
      accesses,
      branchesCount,
    } = request.body as {
      company: {
        cnpj: string;
        legalName: string;
        tradeName: string;
        address: string;
        phone: string;
      };
      branch: {
        socialName: string;
        tradeName: string;
        address: string;
        phone: string;
      };
      sector: {
        name: string;
        description: string;
      };
      user: {
        name: string;
        birthDate: string;
        email: string;
        password: string;
        phone: string;
        address: string;
      };
      accesses: {
        description: string;
      }[];
      branchesCount?: number;
    };

    try {
      const result = await prisma.$transaction(async (tx: any) => {
        // Create company
        const createdCompany = await tx.company.create({
          data: company,
        });

        // create branches list; at least one
        const totalBranches = branchesCount && branchesCount > 0 ? branchesCount : 1;
        const createdBranches = [];
        for (let i = 0; i < totalBranches; i++) {
          if (i === 0) {
            const b = await tx.branch.create({
              data: {
                ...branch,
                companyId: createdCompany.id,
              },
            });
            createdBranches.push(b);
          } else {
            const b = await tx.branch.create({
              data: {
                companyId: createdCompany.id,
                socialName: `${branch.socialName || branch.tradeName} Filial ${i + 1}`,
                tradeName: branch.tradeName,
                address: branch.address,
                phone: branch.phone,
              },
            });
            createdBranches.push(b);
          }
        }

        // Create sector on first branch
        const createdSector = await tx.sector.create({
          data: {
            ...sector,
            branchId: createdBranches[0].id,
          },
        });

        // Create accesses
        const createdAccesses = await Promise.all(
          accesses.map((access) =>
            tx.access.create({
              data: access,
            })
          )
        );

        // Hash password
        const hashedPassword = await bcrypt.hash(user.password, 10);

        // Create user
        const createdUser = await tx.user.create({
          data: {
            name: user.name,
            birthDate: new Date(user.birthDate),
            email: user.email,
            password: hashedPassword,
            phone: user.phone,
            address: user.address,
            sectorId: createdSector.id,
            accesses: {
              connect: createdAccesses.map((acc) => ({ id: acc.id })),
            },
          },
          include: {
            sector: true,
            accesses: {
              include: {
                modules: true  // Incluir módulos dos acessos
              }
            },
          },
        });

        return {
          company: createdCompany,
          branches: createdBranches,
          sector: createdSector,
          accesses: createdAccesses,
          user: createdUser,
        };
      });

      return result;
    } catch (error) {
      console.log('Error during registration:', error);
      return reply.code(400).send({ error: 'Registration failed', details: (error as Error).message });
    }
  });

  // Login route
  app.post('/login', {
    schema: {
      summary: 'Authenticate user',
      tags: ['Auth'],
      body: { $ref: 'LoginRequest#' },
      response: { 200: { $ref: 'AuthResponse#' }, 401: { type: 'object' } },
    },
  }, async (request, reply) => {
      const { email, password } = request.body as {
        email: string;
        password: string;
      };

      const user = await prisma.user.findUnique({
        where: { email },
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
              modules: true  // Incluir módulos dos acessos
            }
          }
        },
      });

      console.log('User fetched for login:', email);

      if (!user) {
        return reply.code(401).send({ error: 'Invalid credentials' });
      }

      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        return reply.code(401).send({ error: 'Invalid credentials' });
      }

      const token = app.jwt.sign({ id: user.id, email: user.email });

      return {
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          address: user.address,
          birthDate: user.birthDate,
          sector: user.sector,
          accesses: user.accesses,
        },
      };
  });

  app.post('/forgot-password', {
    schema: {
      summary: 'Send recovery code to user email',
      tags: ['Auth'],
      body: {
        type: 'object',
        properties: {
          identifier: { type: 'string' },
        },
        required: ['identifier'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request) => {
    const { identifier } = request.body as { identifier: string };
    const normalizedIdentifier = normalizeIdentifier(identifier);

    if (!normalizedIdentifier) {
      return { message: 'Se o usuário existir, enviaremos um código de recuperação.' };
    }

    const user = isEmail(normalizedIdentifier)
      ? await prisma.user.findUnique({ where: { email: normalizedIdentifier } })
      : await prisma.user.findFirst({
          where: {
            OR: [
              { cpf: normalizedIdentifier },
              { cpf: digitsOnly(normalizedIdentifier) },
            ],
          },
        });

    if (!user) {
      return { message: 'Se o usuário existir, enviaremos um código de recuperação.' };
    }

    const code = generateResetCode();
    const codeHash = hashResetCode(code);
    const expiresAt = new Date(Date.now() + RESET_CODE_EXPIRATION_MINUTES * 60 * 1000);

    await prisma.passwordResetCode.create({
      data: {
        userId: user.id,
        requestIdentifier: normalizedIdentifier,
        codeHash,
        expiresAt,
      },
    });

    try {
      await sendPasswordResetCodeEmail({
        to: user.email,
        code,
        userName: user.name,
      });
    } catch (error) {
      app.log.error(error, 'Failed to send password reset email');
    }

    return { message: 'Se o usuário existir, enviaremos um código de recuperação.' };
  });

  app.post('/verify-code', {
    schema: {
      summary: 'Validate recovery code',
      tags: ['Auth'],
      body: {
        type: 'object',
        properties: {
          identifier: { type: 'string' },
          code: { type: 'string' },
        },
        required: ['identifier', 'code'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            valid: { type: 'boolean' },
          },
        },
        400: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const { identifier, code } = request.body as { identifier: string; code: string };

    const normalizedIdentifier = normalizeIdentifier(identifier);
    const normalizedCode = code.trim();

    const user = isEmail(normalizedIdentifier)
      ? await prisma.user.findUnique({ where: { email: normalizedIdentifier } })
      : await prisma.user.findFirst({
          where: {
            OR: [
              { cpf: normalizedIdentifier },
              { cpf: digitsOnly(normalizedIdentifier) },
            ],
          },
        });

    if (!user) {
      return reply.code(400).send({ error: 'Código inválido ou expirado' });
    }

    const resetRecord = await prisma.passwordResetCode.findFirst({
      where: {
        userId: user.id,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!resetRecord) {
      return reply.code(400).send({ error: 'Código inválido ou expirado' });
    }

    const isCodeValid = hashResetCode(normalizedCode) === resetRecord.codeHash;

    if (!isCodeValid) {
      const nextAttempts = resetRecord.attempts + 1;
      await prisma.passwordResetCode.update({
        where: { id: resetRecord.id },
        data: {
          attempts: nextAttempts,
          usedAt: nextAttempts >= 5 ? new Date() : null,
        },
      });

      return reply.code(400).send({ error: 'Código inválido ou expirado' });
    }

    return { valid: true };
  });

  app.post('/reset-password', {
    schema: {
      summary: 'Reset user password using verification code',
      tags: ['Auth'],
      body: {
        type: 'object',
        properties: {
          identifier: { type: 'string' },
          code: { type: 'string' },
          newPassword: { type: 'string' },
        },
        required: ['identifier', 'code', 'newPassword'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
        },
        400: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const { identifier, code, newPassword } = request.body as {
      identifier: string;
      code: string;
      newPassword: string;
    };

    if (!validateStrongPassword(newPassword)) {
      return reply.code(400).send({ error: 'A senha não atende aos requisitos de segurança' });
    }

    const normalizedIdentifier = normalizeIdentifier(identifier);
    const normalizedCode = code.trim();

    const user = isEmail(normalizedIdentifier)
      ? await prisma.user.findUnique({ where: { email: normalizedIdentifier } })
      : await prisma.user.findFirst({
          where: {
            OR: [
              { cpf: normalizedIdentifier },
              { cpf: digitsOnly(normalizedIdentifier) },
            ],
          },
        });

    if (!user) {
      return reply.code(400).send({ error: 'Código inválido ou expirado' });
    }

    const resetRecord = await prisma.passwordResetCode.findFirst({
      where: {
        userId: user.id,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!resetRecord || hashResetCode(normalizedCode) !== resetRecord.codeHash) {
      return reply.code(400).send({ error: 'Código inválido ou expirado' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { password: hashedPassword },
      }),
      prisma.passwordResetCode.update({
        where: { id: resetRecord.id },
        data: { usedAt: new Date() },
      }),
    ]);

    return { message: 'Senha alterada com sucesso' };
  });
}