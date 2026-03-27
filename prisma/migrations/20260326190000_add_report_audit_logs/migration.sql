-- CreateTable
CREATE TABLE "report_audit_logs" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "reportId" TEXT,
    "addendumId" TEXT,
    "action" TEXT NOT NULL,
    "performedByUserId" TEXT,
    "performedByName" TEXT,
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_audit_logs_branchId_createdAt_idx" ON "report_audit_logs"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "report_audit_logs_reportId_idx" ON "report_audit_logs"("reportId");
