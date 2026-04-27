import { PrismaClient } from '@prisma/client';

export async function runTestMatrizField(options: {
  PrismaClientCtor?: typeof PrismaClient;
  logger?: Console;
} = {}) {
  const PrismaClientCtor = options.PrismaClientCtor || PrismaClient;
  const logger = options.logger || console;
  const prisma = new PrismaClientCtor();

  try {
    const branches = await prisma.branch.findMany({
      take: 1,
    });

    logger.log('✅ Primeira filial:');
    logger.log(JSON.stringify(branches[0], null, 2));

    if (branches[0]) {
      logger.log('\n🔍 Campo isMatriz existe?', 'isMatriz' in branches[0]);
      logger.log('Valor de isMatriz:', branches[0].isMatriz);
    }
    return branches[0] || null;
  } catch (error) {
    logger.error('❌ Erro:', error);
    return null;
  } finally {
    await prisma.$disconnect();
  }
}

/* c8 ignore next 3 */
if (require.main === module) {
  void runTestMatrizField();
}
