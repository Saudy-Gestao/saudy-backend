-- Script para marcar a primeira filial de cada empresa como matriz
-- Execute este script no banco de dados para atualizar as filiais existentes

WITH first_branches AS (
  SELECT DISTINCT ON (b."companyId") b.id
  FROM branches b
  ORDER BY b."companyId", b.id ASC
)
UPDATE branches
SET "isMatriz" = CASE 
  WHEN id IN (SELECT id FROM first_branches) THEN true
  ELSE false
END;

-- Verificar o resultado
SELECT 
  c."tradeName" as empresa,
  b."tradeName" as filial,
  b."isMatriz" as matriz
FROM branches b
JOIN companies c ON b."companyId" = c.id
ORDER BY c."tradeName", b.id;
