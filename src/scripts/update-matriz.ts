import { PrismaClient } from '@prisma/client';

export async function runUpdateMatrizFlags(options: {
  PrismaClientCtor?: typeof PrismaClient;
  logger?: Console;
} = {}) {
  const PrismaClientCtor = options.PrismaClientCtor || PrismaClient;
  const logger = options.logger || console;
  const prisma = new PrismaClientCtor();

  try {
    logger.log('🔄 Atualizando flags de matriz nas filiais...');

    // Buscar todas as empresas
    const companies = await prisma.company.findMany({
      include: {
        branches: {
          orderBy: {
            id: 'asc', // Ordenar por ID para pegar a primeira criada
          },
        },
      },
    });

    for (const company of companies) {
      if (company.branches.length > 0) {
        const firstBranch = company.branches[0];
        
        // Marcar a primeira filial como matriz
        await prisma.branch.update({
          where: { id: firstBranch.id },
          data: { isMatriz: true },
        });

        logger.log(`✅ Empresa ${company.tradeName}: Filial "${firstBranch.tradeName}" marcada como Matriz`);

        // Garantir que as outras filiais não sejam matriz
        if (company.branches.length > 1) {
          for (let i = 1; i < company.branches.length; i++) {
            await prisma.branch.update({
              where: { id: company.branches[i].id },
              data: { isMatriz: false },
            });
          }
          logger.log(`   Outras ${company.branches.length - 1} filiais marcadas como não-matriz`);
        }
      }
    }

    logger.log('✨ Atualização concluída com sucesso!');
  } catch (error) {
    logger.error('❌ Erro ao atualizar flags de matriz:', error);
  } finally {
    await prisma.$disconnect();
  }
}

/* c8 ignore next 3 */
if (require.main === module) {
  void runUpdateMatrizFlags();
}
