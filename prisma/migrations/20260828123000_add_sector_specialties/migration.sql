ALTER TABLE "sectors" ADD COLUMN "especialidadeIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "sectors"
SET "especialidadeIds" = ARRAY["especialidadeId"]
WHERE "especialidadeId" IS NOT NULL AND cardinality("especialidadeIds") = 0;
