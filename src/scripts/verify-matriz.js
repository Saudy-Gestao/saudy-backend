const pg = require('pg');

async function runVerifyMatriz(options = {}) {
  const PoolCtor = options.PoolCtor || pg.Pool;
  const logger = options.logger || console;
  const pool = new PoolCtor({
    user: 'postgres',
    host: 'localhost',
    database: 'saudy_db',
    password: 'postgres',
    port: 5432,
  });

  try {
    const res = await pool.query(`
      SELECT 
        b.id,
        b."tradeName",
        b."isMatriz",
        c."tradeName" as company
      FROM branches b
      JOIN companies c ON b."companyId" = c.id
      ORDER BY c.id, b.id
    `);

    logger.log('\n✅ Resultado da query:');
    logger.log(res.rows);
    return res.rows;
  } catch (err) {
    logger.error('❌ Erro:', err.message);
    return [];
  } finally {
    await pool.end();
  }
}

module.exports = { runVerifyMatriz };

/* c8 ignore next 3 */
if (require.main === module) {
  void runVerifyMatriz();
}
