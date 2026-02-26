const pg = require('pg');

const pool = new pg.Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'saudy_db',
  password: 'postgres',
  port: 5432,
});

async function verify() {
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
    
    console.log('\n✅ Resultado da query:');
    console.log(res.rows);
    
  } catch (err) {
    console.error('❌ Erro:', err.message);
  } finally {
    await pool.end();
  }
}

verify();
