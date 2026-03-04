import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function test() {
  try {
    const branches = await prisma.branch.findMany({
      take: 1,
    });
    
    console.log('✅ Primeira filial:');
    console.log(JSON.stringify(branches[0], null, 2));
    
    if (branches[0]) {
      console.log('\n🔍 Campo isMatriz existe?', 'isMatriz' in branches[0]);
      console.log('Valor de isMatriz:', branches[0].isMatriz);
    }
  } catch (error) {
    console.error('❌ Erro:', error);
  } finally {
    await prisma.$disconnect();
  }
}

test();
