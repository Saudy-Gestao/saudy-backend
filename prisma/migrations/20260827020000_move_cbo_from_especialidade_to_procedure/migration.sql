ALTER TABLE "procedures" ADD COLUMN "cboId" TEXT;

CREATE INDEX "procedures_cboId_idx" ON "procedures"("cboId");

ALTER TABLE "procedures"
  ADD CONSTRAINT "procedures_cboId_fkey"
  FOREIGN KEY ("cboId") REFERENCES "cbos"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Preserve the previous classification when the procedure is linked to a specialty.
UPDATE "procedures" AS procedure_row
SET "cboId" = specialty."cboId"
FROM "especialidades" AS specialty
WHERE procedure_row."especialidadeId" = specialty."id"
  AND specialty."cboId" IS NOT NULL;

ALTER TABLE "especialidades" DROP CONSTRAINT IF EXISTS "especialidades_cboId_fkey";
DROP INDEX IF EXISTS "especialidades_cboId_idx";
ALTER TABLE "especialidades" DROP COLUMN IF EXISTS "cboId";
