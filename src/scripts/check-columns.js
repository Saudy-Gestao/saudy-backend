const { exec } = require('child_process');

// Executar comando psql para verificar colunas
exec(
  `psql -U postgres -d saudy_db -h localhost -c "\\d branches"`,
  { env: { ...process.env, PGPASSWORD: 'postgres' } },
  (error, stdout, stderr) => {
    if (error) {
      console.error('Erro:', error.message);
      return;
    }
    if (stderr) {
      console.error('Stderr:', stderr);
      return;
    }
    console.log('📋 Colunas da tabela branches:');
    console.log(stdout);
  }
);
