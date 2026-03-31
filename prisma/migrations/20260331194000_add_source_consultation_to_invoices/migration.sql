ALTER TABLE "invoices"
ADD COLUMN "sourceConsultationId" TEXT;

CREATE UNIQUE INDEX "invoices_sourceConsultationId_key"
ON "invoices"("sourceConsultationId");
