-- Mark the first branch of each company as matriz
UPDATE "branches"
SET "isMatriz" = true
WHERE ("companyId", id) IN (
  SELECT "companyId", MIN(id)
  FROM "branches"
  GROUP BY "companyId"
);
