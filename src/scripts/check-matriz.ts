import { Pool } from 'pg';

const pool = new Pool({
  connectionString: 'postgresql://postgres:postgres@localhost:5432/saudy_db',
});

async function checkMatriz() {
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

    console.log('\n📋 Filiais no banco:');
    console.log('═'.repeat(70));
    result.rows.forEach((row) => {
      console.log(`Empresa: ${row.company_name}`);
      console.log(`  Nome Fantasia: ${row.tradeName}`);
      console.log(`  isMatriz: ${row.isMatriz}`);
      console.log(`  ID: ${row.id}`);
      console.log('─'.repeat(70));
    });
  } catch (error) {
    console.error('❌ Erro:', error);
  } finally {
    await pool.end();
  }
}

checkMatriz();
