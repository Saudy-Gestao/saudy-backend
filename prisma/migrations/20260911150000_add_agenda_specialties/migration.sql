ALTER TABLE "agendas"
  ADD COLUMN "especialidadeIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "agendas"
SET "especialidadeIds" = ARRAY["especialidadeId"]
WHERE "especialidadeId" IS NOT NULL
  AND cardinality("especialidadeIds") = 0;
