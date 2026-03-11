-- CreateTable
CREATE TABLE "dicom_files" (
    "id" TEXT NOT NULL,
    "worklistItemId" TEXT NOT NULL,
    "studyUid" TEXT,
    "seriesUid" TEXT,
    "path" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dicom_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dicom_files_worklistItemId_idx" ON "dicom_files"("worklistItemId");

-- AddForeignKey
ALTER TABLE "dicom_files" ADD CONSTRAINT "dicom_files_worklistItemId_fkey" FOREIGN KEY ("worklistItemId") REFERENCES "report_worklist_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
