-- DropForeignKey
ALTER TABLE "report_addendums" DROP CONSTRAINT "report_addendums_worklistItemId_fkey";

-- AlterTable
ALTER TABLE "report_addendums" ADD COLUMN     "reportId" TEXT,
ALTER COLUMN "worklistItemId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "appointmentId" TEXT,
ADD COLUMN     "worklistItemId" TEXT,
ALTER COLUMN "patientName" DROP NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'rascunho';

-- CreateIndex
CREATE INDEX "report_addendums_reportId_status_idx" ON "report_addendums"("reportId", "status");

-- CreateIndex
CREATE INDEX "reports_worklistItemId_idx" ON "reports"("worklistItemId");

-- CreateIndex
CREATE INDEX "reports_appointmentId_idx" ON "reports"("appointmentId");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_worklistItemId_fkey" FOREIGN KEY ("worklistItemId") REFERENCES "report_worklist_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_addendums" ADD CONSTRAINT "report_addendums_worklistItemId_fkey" FOREIGN KEY ("worklistItemId") REFERENCES "report_worklist_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_addendums" ADD CONSTRAINT "report_addendums_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
