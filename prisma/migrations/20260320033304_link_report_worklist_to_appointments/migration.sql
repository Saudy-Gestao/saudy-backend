/*
  Warnings:

  - Made the column `workingSchedules` on table `doctors` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "doctors" ALTER COLUMN "workingSchedules" SET NOT NULL;

-- AlterTable
ALTER TABLE "report_worklist_items" ADD COLUMN     "appointmentId" TEXT;

-- CreateIndex
CREATE INDEX "report_worklist_items_appointmentId_idx" ON "report_worklist_items"("appointmentId");

-- AddForeignKey
ALTER TABLE "report_worklist_items" ADD CONSTRAINT "report_worklist_items_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
