-- Resetar todas as filiais
UPDATE branches SET "isMatriz" = false;

-- Marcar primeira filial de cada empresa como matriz
WITH first_branches AS (
  SELECT 
    "companyId",
    MIN(id) as first_id
  FROM branches
  GROUP BY "companyId"
)
UPDATE branches b
SET "isMatriz" = true
FROM first_branches fb
WHERE b.id = fb.first_id;

-- Verificar resultado
SELECT 
    b.id,
    b."tradeName" as filial,
    b."isMatriz" as matriz,
    c."tradeName" as empresa
FROM branches b
JOIN companies c ON b."companyId" = c.id
ORDER BY c.id, b.id;
