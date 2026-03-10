import 'dotenv/config';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma';

function digitsOnly(value: string) {
  return value.replace(/\D/g, '');
}

function isEmail(value: string) {
  return value.includes('@');
}

async function main() {
  const identifier = String(process.argv[2] || '').trim();
  const newPassword = String(process.argv[3] || '').trim();

  if (!identifier || !newPassword) {
    console.error('Usage: pnpm exec tsx src/scripts/reset-user-password.ts <email_or_cpf> <new_password>');
    process.exit(1);
  }

  const users = isEmail(identifier)
    ? await prisma.user.findMany({
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
    : await prisma.user.findMany({
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
    console.error('No users found for identifier:', identifier);
    process.exit(1);
  }

  const hashedPassword = await bcrypt.hash(newPassword, 10);

  await prisma.$transaction(
    users.map((user: { id: string; email: string }) =>
      prisma.user.update({
        where: { id: user.id },
        data: {
          password: hashedPassword,
          email: user.email.trim().toLowerCase(),
        },
      })
    )
  );

  console.log('Password reset completed for users:');
  for (const user of users) {
    console.log(`- ${user.id} | ${user.email} | cpf=${user.cpf ?? 'null'}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
