-- CreateTable
CREATE TABLE "report_addendums" (
    "id" TEXT NOT NULL,
    "worklistItemId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "issuerSignedAt" TEXT,
    "reviewerSignedAt" TEXT,
    "savedAt" TEXT,
    "finalizedAt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "report_addendums_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_addendums_worklistItemId_status_idx" ON "report_addendums"("worklistItemId", "status");

-- AddForeignKey
ALTER TABLE "report_addendums" ADD CONSTRAINT "report_addendums_worklistItemId_fkey" FOREIGN KEY ("worklistItemId") REFERENCES "report_worklist_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
