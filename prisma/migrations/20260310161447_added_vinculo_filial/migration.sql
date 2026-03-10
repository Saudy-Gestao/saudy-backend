-- DropIndex
DROP INDEX "appointments_authorizationStatus_idx";

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "pre_attendances" ADD COLUMN     "branchId" TEXT;

-- CreateIndex
CREATE INDEX "appointments_branchId_idx" ON "appointments"("branchId");

-- CreateIndex
CREATE INDEX "patients_branchId_idx" ON "patients"("branchId");

-- CreateIndex
CREATE INDEX "pre_attendances_branchId_idx" ON "pre_attendances"("branchId");
