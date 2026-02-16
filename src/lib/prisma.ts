import { PrismaClient } from '@prisma/client';
import { createPrismaAdapter } from './prisma-adapter';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const prismaClient = globalForPrisma.prisma ?? new PrismaClient({
  adapter: createPrismaAdapter(),
});

const prisma: any = prismaClient;

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prismaClient;
}

export default prisma;
