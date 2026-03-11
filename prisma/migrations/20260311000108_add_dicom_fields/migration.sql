-- AlterTable
ALTER TABLE "report_worklist_items" ADD COLUMN     "dicomPath" TEXT,
ADD COLUMN     "dicomReceivedAt" TIMESTAMP(3),
ADD COLUMN     "dicomUrl" TEXT;

-- CreateIndex
CREATE INDEX "report_worklist_items_dicomStudyUid_idx" ON "report_worklist_items"("dicomStudyUid");
