-- AlterTable
ALTER TABLE "appointments"
ADD COLUMN "sourceConsultationId" TEXT,
ADD COLUMN "sourceProcedureId" TEXT,
ADD COLUMN "orderPriority" TEXT,
ADD COLUMN "orderNotes" TEXT,
ADD COLUMN "preferredDate" TEXT,
ADD COLUMN "preferredTime" TEXT,
ADD COLUMN "orderedAt" TIMESTAMP(3),
ADD COLUMN "requestedByDoctor" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "scheduledByDoctor" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "appointments_sourceConsultationId_idx" ON "appointments"("sourceConsultationId");

-- CreateIndex
CREATE INDEX "appointments_sourceProcedureId_idx" ON "appointments"("sourceProcedureId");
