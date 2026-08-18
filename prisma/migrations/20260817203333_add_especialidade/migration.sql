-- CreateTable
CREATE TABLE "especialidades" (
    "id" TEXT NOT NULL,
    "branchId" TEXT,
    "modalidadeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metodos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdByName" TEXT,
    "updatedByUserId" TEXT,
    "updatedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "especialidades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "especialidade_audit_logs" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "especialidadeId" TEXT,
    "action" TEXT NOT NULL,
    "performedByUserId" TEXT,
    "performedByName" TEXT,
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "especialidade_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "especialidades_branchId_idx" ON "especialidades"("branchId");

-- CreateIndex
CREATE INDEX "especialidades_modalidadeId_idx" ON "especialidades"("modalidadeId");

-- CreateIndex
CREATE INDEX "especialidade_audit_logs_branchId_createdAt_idx" ON "especialidade_audit_logs"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "especialidade_audit_logs_especialidadeId_idx" ON "especialidade_audit_logs"("especialidadeId");

-- AddForeignKey
ALTER TABLE "especialidades" ADD CONSTRAINT "especialidades_modalidadeId_fkey" FOREIGN KEY ("modalidadeId") REFERENCES "modalidades"("id") ON DELETE CASCADE ON UPDATE CASCADE;
