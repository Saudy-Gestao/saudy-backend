-- Verificar valores de isMatriz
SELECT 
  id, 
  "tradeName", 
  "companyId",
  "isMatriz"
FROM branches
ORDER BY "companyId", id;
