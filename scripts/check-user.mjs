import { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'url';

export async function runCheckUser(options = {}) {
  const PrismaClientCtor = options.PrismaClientCtor || PrismaClient;
  const argv = options.argv || process.argv;
  const logger = options.logger || console;
  const setExitCode = options.setExitCode || ((code) => {
    process.exitCode = code;
  });
  const prisma = new PrismaClientCtor();
  const identifier = argv[2] || 'Eduardo@email.com';

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
    logger.log(JSON.stringify(users, null, 2));
    return users;
  } catch (e) {
    logger.error(e);
    setExitCode(1);
    return [];
  } finally {
    await prisma.$disconnect();
  }
}

/* c8 ignore next 4 */
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await runCheckUser();
}
