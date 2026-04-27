import { Pool } from 'pg';

export async function runCheckMatriz(options: {
  PoolCtor?: typeof Pool;
  logger?: Console;
} = {}) {
  const PoolCtor = options.PoolCtor || Pool;
  const logger = options.logger || console;
  const pool = new PoolCtor({
    connectionString: 'postgresql://postgres:postgres@localhost:5432/saudy_db',
  });

  try {
    const result = await pool.query(`
      SELECT 
        b.id,
        b."tradeName",
        b."socialName",
        b."isMatriz",
        c."tradeName" as company_name
      FROM branches b
      JOIN companies c ON b."companyId" = c.id
      ORDER BY c.id, b.id
    `);

    logger.log('\n📋 Filiais no banco:');
    logger.log('═'.repeat(70));
    result.rows.forEach((row) => {
      logger.log(`Empresa: ${row.company_name}`);
      logger.log(`  Nome Fantasia: ${row.tradeName}`);
      logger.log(`  isMatriz: ${row.isMatriz}`);
      logger.log(`  ID: ${row.id}`);
      logger.log('─'.repeat(70));
    });
    return result.rows;
  } catch (error) {
    logger.error('❌ Erro:', error);
    return [];
  } finally {
    await pool.end();
  }
}

/* c8 ignore next 3 */
if (require.main === module) {
  void runCheckMatriz();
}
