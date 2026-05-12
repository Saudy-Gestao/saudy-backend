import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { sendAdminRegisterCodeEmail, sendPasswordResetCodeEmail, sendWelcomeEmail } from '../lib/mailer';
import { Prisma } from '@prisma/client';
import {
  findCompanyByNormalizedCnpj,
  isValidNormalizedCnpj,
  normalizeCnpj,
} from '../lib/cnpj';

const RESET_CODE_EXPIRATION_MINUTES = 10;
const ADMIN_EMAIL_CODE_EXPIRATION_MINUTES = 10;

function hashResetCode(code: string) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function generateResetCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function normalizeIdentifier(value: string) {
  return value.trim();
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
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

function isBcryptHash(value: string) {
  return /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value);
}

function isEtechdevDomain(email: string) {
  return /@etechdev(?:\.[a-z0-9-]+)*$/i.test(email.trim());
}

async function validateUserPassword(userId: string, storedPassword: string, incomingPassword: string) {
  if (!storedPassword || !isBcryptHash(storedPassword)) {
    return false;
  }

  return bcrypt.compare(incomingPassword, storedPassword);
}

async function findUsersByIdentifier(identifier: string) {
  const normalizedIdentifier = normalizeIdentifier(identifier);
  if (!normalizedIdentifier) return [] as any[];

  if (isEmail(normalizedIdentifier)) {
    const usersByEmail = await prisma.user.findMany({
      where: {
        email: { equals: normalizedIdentifier, mode: 'insensitive' },
      },
    });

    const exactCase = usersByEmail.filter((u: any) => u.email === normalizedIdentifier);
    const remaining = usersByEmail.filter((u: any) => u.email !== normalizedIdentifier);
    return [...exactCase, ...remaining];
  }

  const normalizedCpf = digitsOnly(normalizedIdentifier);
  if (!normalizedCpf) return [] as any[];

  return prisma.user.findMany({
    where: {
      OR: [
        { cpf: normalizedCpf },
        { cpf: normalizedIdentifier },
      ],
    },
  });
}

export default async function authRoutes(app: FastifyInstance) {
  app.post('/adm/login', {
    schema: {
      summary: 'Authenticate ADM Hub user',
      tags: ['Auth'],
      body: {
        type: 'object',
        properties: {
          email: { type: 'string' },
          password: { type: 'string' },
        },
        required: ['email', 'password'],
      },
      response: {
        200: { $ref: 'AuthResponse#' },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        403: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string };
    const normalizedEmail = normalizeEmail(String(email || ''));

    const adminUser = await prisma.adminUser.findFirst({
      where: {
        email: {
          equals: normalizedEmail,
          mode: 'insensitive',
        },
      },
    });

    if (!adminUser) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const isPasswordValid = await bcrypt.compare(String(password || ''), adminUser.password);
    if (!isPasswordValid) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    if (!adminUser.emailVerifiedAt) {
      return reply.code(403).send({ error: 'E-mail não verificado. Confirme o código enviado para continuar.' });
    }

    const token = app.jwt.sign({ id: adminUser.id, email: adminUser.email, admHubOnly: true });

    return {
      token,
      user: {
        id: adminUser.id,
        name: adminUser.name,
        email: adminUser.email,
        isAdmHubOnly: true,
      },
    };
  });

  app.post('/adm/request-register-code', {
    schema: {
      summary: 'Request admin registration code',
      tags: ['Auth'],
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
          password: { type: 'string' },
        },
        required: ['name', 'email', 'password'],
      },
    },
  }, async (request, reply) => {
    const { name, email, password } = request.body as {
      name: string;
      email: string;
      password: string;
    };

    const normalizedName = String(name || '').trim();
    const normalizedEmail = normalizeEmail(String(email || ''));
    const incomingPassword = String(password || '');

    if (!normalizedName || !normalizedEmail || !incomingPassword) {
      return reply.code(400).send({ error: 'Preencha todos os campos obrigatórios' });
    }

    if (!isEtechdevDomain(normalizedEmail)) {
      return reply.code(400).send({ error: 'Apenas e-mails do domínio @etechdev são permitidos' });
    }

    if (!validateStrongPassword(incomingPassword)) {
      return reply.code(400).send({ error: 'A senha não atende aos requisitos de segurança' });
    }

    const code = generateResetCode();
    const codeHash = hashResetCode(code);
    const expiresAt = new Date(Date.now() + ADMIN_EMAIL_CODE_EXPIRATION_MINUTES * 60 * 1000);
    const hashedPassword = await bcrypt.hash(incomingPassword, 10);

    await prisma.adminUser.upsert({
      where: { email: normalizedEmail },
      create: {
        name: normalizedName,
        email: normalizedEmail,
        password: hashedPassword,
        emailCodeHash: codeHash,
        emailCodeExpiresAt: expiresAt,
        emailVerifiedAt: null,
      },
      update: {
        name: normalizedName,
        password: hashedPassword,
        emailCodeHash: codeHash,
        emailCodeExpiresAt: expiresAt,
        emailVerifiedAt: null,
      },
    });

    try {
      const sent = await sendAdminRegisterCodeEmail({
        to: normalizedEmail,
        code,
        userName: normalizedName,
      });

      if (!sent) {
        return reply.code(500).send({ error: 'Serviço de e-mail não configurado para validação ADM' });
      }
    } catch (error) {
      app.log.error(error, 'Failed to send admin register email');
      return reply.code(500).send({ error: 'Falha ao enviar código de confirmação' });
    }

    return { message: 'Código enviado para o e-mail informado' };
  });

  app.post('/adm/verify-register-code', {
    schema: {
      summary: 'Verify admin registration code',
      tags: ['Auth'],
      body: {
        type: 'object',
        properties: {
          email: { type: 'string' },
          code: { type: 'string' },
        },
        required: ['email', 'code'],
      },
    },
  }, async (request, reply) => {
    const { email, code } = request.body as { email: string; code: string };
    const normalizedEmail = normalizeEmail(String(email || ''));
    const normalizedCode = String(code || '').trim();

    const adminUser = await prisma.adminUser.findUnique({ where: { email: normalizedEmail } });

    if (!adminUser || !adminUser.emailCodeHash || !adminUser.emailCodeExpiresAt) {
      return reply.code(400).send({ error: 'Código inválido ou expirado' });
    }

    if (adminUser.emailCodeExpiresAt <= new Date()) {
      return reply.code(400).send({ error: 'Código inválido ou expirado' });
    }

    if (hashResetCode(normalizedCode) !== adminUser.emailCodeHash) {
      return reply.code(400).send({ error: 'Código inválido ou expirado' });
    }

    const updatedAdminUser = await prisma.adminUser.update({
      where: { id: adminUser.id },
      data: {
        emailVerifiedAt: new Date(),
        emailCodeHash: null,
        emailCodeExpiresAt: null,
      },
    });

    const token = app.jwt.sign({ id: updatedAdminUser.id, email: updatedAdminUser.email, admHubOnly: true });

    return {
      token,
      user: {
        id: updatedAdminUser.id,
        name: updatedAdminUser.name,
        email: updatedAdminUser.email,
        isAdmHubOnly: true,
      },
    };
  });

  // Register complete setup
  app.post('/register', {
    schema: {
      summary: 'Register a complete company/branch/sector/user setup',
      tags: ['Auth'],
      body: { $ref: 'RegisterRequest#' },
      response: {
        200: { $ref: 'RegisterResponse#' },
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
            details: { type: 'string' },
          },
        },
        409: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            details: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const {
      company,
      branch,
      sector,
      user,
      accesses,
      branchesCount,
      modulo,
    } = request.body as {
      company: {
        cnpj: string;
        legalName: string;
        tradeName: string;
        address: string;
        phone: string;
      };
      branch: {
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
      modulo?: string;
    };

    try {
      const result = await prisma.$transaction(async (tx: any) => {
        const normalizedCnpj = normalizeCnpj(company.cnpj);

        if (!isValidNormalizedCnpj(normalizedCnpj)) {
          throw new Error('CNPJ inválido');
        }

        const existingCompany = await findCompanyByNormalizedCnpj(tx, normalizedCnpj);
        if (existingCompany) {
          throw new Error('CNPJ já cadastrado');
        }

        // Create company
        const createdCompany = await tx.company.create({
          data: {
            ...company,
            cnpj: normalizedCnpj,
            module_type: modulo || 'padrao',
            additionalBranchesAllowed: Math.max(0, Number(branchesCount || 0)),
          },
        });

        // Always create only the matriz during onboarding.
        // Additional branches must be created later from Settings.
        const matrizBranch = await tx.branch.create({
          data: {
            ...branch,
            companyId: createdCompany.id,
            isMatriz: true,
          },
        });

        const createdBranches = [matrizBranch];

        // Create sector on first branch
        const createdSector = await tx.sector.create({
          data: {
            ...sector,
            branchId: createdBranches[0].id,
          },
        });

        // Create accesses (only if provided)
        const createdAccesses = accesses && accesses.length > 0 
          ? await Promise.all(
              accesses.map((access) =>
                tx.access.create({
                  data: access,
                })
              )
            )
          : [];

        // Compatibility: accept either plain password (hash here) or a pre-hashed bcrypt password.
        const normalizedEmail = String(user.email || '').trim().toLowerCase();
        const incomingPassword = String(user.password || '');
        const hashedPassword = isBcryptHash(incomingPassword)
          ? incomingPassword
          : await bcrypt.hash(incomingPassword, 10);

        // Create user
        const createdUser = await tx.user.create({
          data: {
            name: user.name,
            birthDate: new Date(user.birthDate),
            email: normalizedEmail,
            password: hashedPassword,
            phone: user.phone,
            address: user.address,
            sectorId: createdSector.id,
            accesses: createdAccesses.length > 0
              ? {
                  connect: createdAccesses.map((acc) => ({ id: acc.id })),
                }
              : undefined,
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

      const token = app.jwt.sign({ id: result.user.id, email: result.user.email });

      // Enviar e-mail de boas-vindas
      try {
        if (result.user.email) {
          await sendWelcomeEmail({
            to: result.user.email,
            login: result.user.email,
            userName: result.user.name,
          });
        }
      } catch (e) {
        console.warn('Falha ao enviar e-mail de boas-vindas:', e);
      }
      return {
        company: result.company,
        branches: result.branches,
        sector: result.sector,
        accesses: result.accesses,
        token,
        user: {
          id: result.user.id,
          name: result.user.name,
          email: result.user.email,
          phone: result.user.phone,
          address: result.user.address,
          birthDate: result.user.birthDate,
          sector: result.user.sector,
          accesses: result.user.accesses,
        },
      };
    } catch (error) {
      if ((error as Error).message === 'CNPJ já cadastrado') {
        return reply.code(409).send({ error: 'Duplicate CNPJ', details: 'CNPJ já cadastrado' });
      }

      if ((error as Error).message === 'CNPJ inválido') {
        return reply.code(400).send({ error: 'Invalid CNPJ', details: 'CNPJ inválido' });
      }

      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target = Array.isArray(error.meta?.target) ? error.meta?.target.join(',') : String(error.meta?.target || '');
        if (target.includes('cnpj')) {
          return reply.code(409).send({ error: 'Duplicate CNPJ', details: 'CNPJ já cadastrado' });
        }
      }

      return reply.code(400).send({ error: 'Registration failed', details: (error as Error).message });
    }
  });

  // Login route
  app.post('/login', {
    schema: {
      summary: 'Authenticate user',
      tags: ['Auth'],
      body: { $ref: 'LoginRequest#' },
      response: {
        200: { $ref: 'AuthResponse#' },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
          },
        },
        403: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
      const { email, password } = request.body as {
        email: string;
        password: string;
      };

      const identifier = String(email || '').trim();
      const normalizedEmail = identifier.toLowerCase();
      const normalizedCpf = digitsOnly(identifier);
      const loginByEmail = isEmail(identifier);

      if (loginByEmail) {
        const adminUser = await prisma.adminUser.findUnique({ where: { email: normalizedEmail } });

        if (adminUser) {
          const isAdminPasswordValid = await bcrypt.compare(password, adminUser.password);
          if (isAdminPasswordValid) {
            if (!adminUser.emailVerifiedAt) {
              return reply.code(403).send({ error: 'E-mail não verificado. Confirme o código enviado para continuar.' });
            }

            const token = app.jwt.sign({ id: adminUser.id, email: adminUser.email, admHubOnly: true });

            return {
              token,
              user: {
                id: adminUser.id,
                name: adminUser.name,
                email: adminUser.email,
                isAdmHubOnly: true,
              },
            };
          }
        }
      }

      const includeRelations = {
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
        doctor: {
          select: {
            id: true,
            name: true,
            specialty: true,
            specialties: true,
            branchId: true,
          },
        },
      } as const;

      const candidateUsers: any[] = [];

      if (loginByEmail) {
        const usersByEmail = await prisma.user.findMany({
          where: {
            email: { equals: identifier, mode: 'insensitive' },
          },
          include: includeRelations,
        });

        // Prefer exact case match first, then keep remaining legacy candidates.
        const exactCase = usersByEmail.filter((u: any) => u.email === identifier);
        const remaining = usersByEmail.filter((u: any) => u.email !== identifier);
        candidateUsers.push(...exactCase, ...remaining);
      } else if (normalizedCpf) {
        // Allow logging in with CPF, as suggested by the UI label "E-mail/CPF".
        const userByCpf = await prisma.user.findFirst({
          where: {
            OR: [
              { cpf: normalizedCpf },
              { cpf: identifier },
            ],
          },
          include: includeRelations,
        });

        if (userByCpf) {
          candidateUsers.push(userByCpf);
        }
      }

      if (candidateUsers.length === 0) {
        return reply.code(401).send({ error: 'Invalid credentials' });
      }

      let authenticatedUser: any = null;
      for (const candidate of candidateUsers) {
        const isPasswordValid = await validateUserPassword(candidate.id, candidate.password, password);
        if (isPasswordValid) {
          authenticatedUser = candidate;
          break;
        }
      }

      if (!authenticatedUser) {
        return reply.code(401).send({ error: 'Invalid credentials' });
      }

      const token = app.jwt.sign({
        id: authenticatedUser.id,
        email: authenticatedUser.email,
        companyId: authenticatedUser.sector?.branch?.companyId || null,
        branchId: authenticatedUser.sector?.branch?.id || null,
        doctorId: authenticatedUser.doctor?.id || null,
      });

      return {
        token,
        user: {
          id: authenticatedUser.id,
          name: authenticatedUser.name,
          email: authenticatedUser.email,
          phone: authenticatedUser.phone,
          address: authenticatedUser.address,
          birthDate: authenticatedUser.birthDate,
          companyId: authenticatedUser.sector?.branch?.companyId || null,
          branchId: authenticatedUser.sector?.branch?.id || null,
          doctorId: authenticatedUser.doctor?.id || null,
          branch: authenticatedUser.sector?.branch || null,
          sector: authenticatedUser.sector,
          doctor: authenticatedUser.doctor || null,
          accesses: authenticatedUser.accesses,
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

    const users = await findUsersByIdentifier(normalizedIdentifier);

    if (users.length === 0) {
      return { message: 'Se o usuário existir, enviaremos um código de recuperação.' };
    }

    const code = generateResetCode();
    const codeHash = hashResetCode(code);
    const expiresAt = new Date(Date.now() + RESET_CODE_EXPIRATION_MINUTES * 60 * 1000);

    await Promise.all(
      users.map((user: { id: string }) =>
        prisma.passwordResetCode.create({
          data: {
            userId: user.id,
            requestIdentifier: isEmail(normalizedIdentifier)
              ? normalizeEmail(normalizedIdentifier)
              : digitsOnly(normalizedIdentifier),
            codeHash,
            expiresAt,
          },
        })
      )
    );

    try {
      await sendPasswordResetCodeEmail({
        to: users[0].email,
        code,
        userName: users[0].name,
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

    const users = await findUsersByIdentifier(normalizedIdentifier);

    if (users.length === 0) {
      return reply.code(400).send({ error: 'Código inválido ou expirado' });
    }

    const candidateUserIds = users.map((user: { id: string }) => user.id);

    const resetRecord = await prisma.passwordResetCode.findFirst({
      where: {
        userId: { in: candidateUserIds },
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

    const users = await findUsersByIdentifier(normalizedIdentifier);

    if (users.length === 0) {
      return reply.code(400).send({ error: 'Código inválido ou expirado' });
    }

    const candidateUserIds = users.map((user: { id: string }) => user.id);
    const codeHash = hashResetCode(normalizedCode);

    const resetRecord = await prisma.passwordResetCode.findFirst({
      where: {
        userId: { in: candidateUserIds },
        usedAt: null,
        expiresAt: { gt: new Date() },
        codeHash,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!resetRecord) {
      return reply.code(400).send({ error: 'Código inválido ou expirado' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: resetRecord.userId },
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
