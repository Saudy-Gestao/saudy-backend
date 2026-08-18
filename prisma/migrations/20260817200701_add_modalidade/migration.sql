-- DropIndex
DROP INDEX "report_addendums_issuerDoctorId_idx";

-- DropIndex
DROP INDEX "reports_finalizedAt_idx";

-- CreateTable
CREATE TABLE "modalidades" (
    "id" TEXT NOT NULL,
    "branchId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdByName" TEXT,
    "updatedByUserId" TEXT,
    "updatedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "modalidades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modalidade_audit_logs" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "modalidadeId" TEXT,
    "action" TEXT NOT NULL,
    "performedByUserId" TEXT,
    "performedByName" TEXT,
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "modalidade_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "modalidades_branchId_idx" ON "modalidades"("branchId");

-- CreateIndex
CREATE INDEX "modalidade_audit_logs_branchId_createdAt_idx" ON "modalidade_audit_logs"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "modalidade_audit_logs_modalidadeId_idx" ON "modalidade_audit_logs"("modalidadeId");
