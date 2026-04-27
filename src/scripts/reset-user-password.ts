import 'dotenv/config';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma';

export function digitsOnly(value: string) {
  return value.replace(/\D/g, '');
}

export function isEmail(value: string) {
  return value.includes('@');
}

export async function runResetUserPassword(options: {
  argv?: string[];
  prismaClient?: typeof prisma;
  bcryptLib?: typeof bcrypt;
  logger?: Console;
  exit?: (code: number) => never | void;
} = {}) {
  const argv = options.argv || process.argv;
  const prismaClient = options.prismaClient || prisma;
  const bcryptLib = options.bcryptLib || bcrypt;
  const logger = options.logger || console;
  const exit = options.exit || ((code: number) => process.exit(code));

  const identifier = String(argv[2] || '').trim();
  const newPassword = String(argv[3] || '').trim();

  if (!identifier || !newPassword) {
    logger.error('Usage: pnpm exec tsx src/scripts/reset-user-password.ts <email_or_cpf> <new_password>');
    exit(1);
    return;
  }

  const users = isEmail(identifier)
    ? await prismaClient.user.findMany({
        where: {
          email: {
            equals: identifier,
            mode: 'insensitive',
          },
        },
        select: {
          id: true,
          email: true,
          cpf: true,
        },
      })
    : await prismaClient.user.findMany({
        where: {
          OR: [
            { cpf: identifier },
            { cpf: digitsOnly(identifier) },
          ],
        },
        select: {
          id: true,
          email: true,
          cpf: true,
        },
      });

  if (users.length === 0) {
    logger.error('No users found for identifier:', identifier);
    exit(1);
    return;
  }

  const hashedPassword = await bcryptLib.hash(newPassword, 10);

  await prismaClient.$transaction(
    users.map((user: { id: string; email: string }) =>
      prismaClient.user.update({
        where: { id: user.id },
        data: {
          password: hashedPassword,
          email: user.email.trim().toLowerCase(),
        },
      })
    )
  );

  logger.log('Password reset completed for users:');
  for (const user of users) {
    logger.log(`- ${user.id} | ${user.email} | cpf=${user.cpf ?? 'null'}`);
  }
  return users;
}

/* c8 ignore next 9 */
if (require.main === module) {
  runResetUserPassword()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
}
