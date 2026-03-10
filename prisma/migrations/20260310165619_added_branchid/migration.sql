-- AlterTable
ALTER TABLE "consultations" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "doctors" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "envelopments" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "insurances" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "procedures" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "report_addendums" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "report_configs" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "report_phrases" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "report_templates" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "report_worklist_items" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "branchId" TEXT;

-- CreateIndex
CREATE INDEX "consultations_branchId_idx" ON "consultations"("branchId");

-- CreateIndex
CREATE INDEX "doctors_branchId_idx" ON "doctors"("branchId");

-- CreateIndex
CREATE INDEX "documents_branchId_idx" ON "documents"("branchId");

-- CreateIndex
CREATE INDEX "envelopments_branchId_idx" ON "envelopments"("branchId");

-- CreateIndex
CREATE INDEX "insurances_branchId_idx" ON "insurances"("branchId");

-- CreateIndex
CREATE INDEX "procedures_branchId_idx" ON "procedures"("branchId");

-- CreateIndex
CREATE INDEX "report_addendums_branchId_idx" ON "report_addendums"("branchId");

-- CreateIndex
CREATE INDEX "report_configs_branchId_idx" ON "report_configs"("branchId");

-- CreateIndex
CREATE INDEX "report_phrases_branchId_idx" ON "report_phrases"("branchId");

-- CreateIndex
CREATE INDEX "report_templates_branchId_idx" ON "report_templates"("branchId");

-- CreateIndex
CREATE INDEX "report_worklist_items_branchId_idx" ON "report_worklist_items"("branchId");

-- CreateIndex
CREATE INDEX "reports_branchId_idx" ON "reports"("branchId");
