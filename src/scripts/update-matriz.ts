import { PrismaClient } from '@prisma/client';

// Criar cliente sem adapter para scripts
const prisma = new PrismaClient();

async function updateMatrizFlags() {
  try {
    console.log('🔄 Atualizando flags de matriz nas filiais...');

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

        console.log(`✅ Empresa ${company.tradeName}: Filial "${firstBranch.tradeName}" marcada como Matriz`);

        // Garantir que as outras filiais não sejam matriz
        if (company.branches.length > 1) {
          for (let i = 1; i < company.branches.length; i++) {
            await prisma.branch.update({
              where: { id: company.branches[i].id },
              data: { isMatriz: false },
            });
          }
          console.log(`   Outras ${company.branches.length - 1} filiais marcadas como não-matriz`);
        }
      }
    }

    console.log('✨ Atualização concluída com sucesso!');
  } catch (error) {
    console.error('❌ Erro ao atualizar flags de matriz:', error);
  } finally {
    await prisma.$disconnect();
  }
}

updateMatrizFlags();
