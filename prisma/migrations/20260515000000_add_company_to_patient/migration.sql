-- AlterTable: add companyId column
ALTER TABLE "patients" ADD COLUMN "companyId" TEXT;

-- Populate companyId from existing branchId via branches table
UPDATE "patients" p
SET "companyId" = b."companyId"
FROM "branches" b
WHERE p."branchId" = b.id
  AND p."companyId" IS NULL;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DropIndex: remove global CPF uniqueness
DROP INDEX IF EXISTS "patients_cpf_key";

-- CreateIndex: unique per company
CREATE UNIQUE INDEX "patients_cpf_companyId_key" ON "patients"("cpf", "companyId");

-- CreateIndex
CREATE INDEX "patients_companyId_idx" ON "patients"("companyId");
