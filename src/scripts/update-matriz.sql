-- Script para marcar a primeira filial de cada empresa como matriz
-- Execute este script no banco de dados para atualizar as filiais existentes

-- Primeiro, reseta todas para false
UPDATE branches SET "isMatriz" = false;

-- Depois marca a primeira de cada empresa como true (por data de criação)
WITH first_branches AS (
  SELECT b.id
  FROM branches b
  INNER JOIN (
    SELECT "companyId", MIN(id) as first_id
    FROM branches
    GROUP BY "companyId"
  ) first ON b.id = first.first_id
)
UPDATE branches
SET "isMatriz" = true
WHERE id IN (SELECT id FROM first_branches);

-- Verificar o resultado
SELECT 
  c."tradeName" as empresa,
  b."tradeName" as filial,
  b."isMatriz" as matriz,
  b.id as branch_id
FROM branches b
JOIN companies c ON b."companyId" = c.id
ORDER BY c."tradeName", b.id;
