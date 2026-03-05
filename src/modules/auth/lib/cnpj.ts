import { Prisma, PrismaClient } from '@prisma/client';

export function normalizeCnpj(cnpj: string): string {
  return (cnpj || '').replace(/\D/g, '');
}

export function isValidNormalizedCnpj(cnpj: string): boolean {
  return cnpj.length === 14 && !/^(\d)\1+$/.test(cnpj);
}

type PrismaDbClient = PrismaClient | Prisma.TransactionClient;

export async function findCompanyByNormalizedCnpj(
  db: PrismaDbClient,
  normalizedCnpj: string,
  excludeCompanyId?: string,
) {
  const rows = await db.$queryRaw<Array<{ id: string; cnpj: string }>>(Prisma.sql`
    SELECT id, cnpj
    FROM companies
    WHERE regexp_replace(cnpj, '[^0-9]', '', 'g') = ${normalizedCnpj}
    ${excludeCompanyId ? Prisma.sql`AND id <> ${excludeCompanyId}` : Prisma.empty}
    LIMIT 1
  `);

  return rows[0] || null;
}
