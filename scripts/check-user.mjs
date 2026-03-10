import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const identifier = process.argv[2] || 'Eduardo@email.com';

try {
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { email: { equals: identifier, mode: 'insensitive' } },
        { cpf: identifier.replace(/\D/g, '') },
        { cpf: identifier },
      ],
    },
    select: { id: true, email: true, cpf: true, password: true },
  });
  console.log(JSON.stringify(users, null, 2));
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
