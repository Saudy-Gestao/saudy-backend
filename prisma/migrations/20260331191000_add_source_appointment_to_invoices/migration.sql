ALTER TABLE "invoices"
ADD COLUMN "sourceAppointmentId" TEXT;

CREATE UNIQUE INDEX "invoices_sourceAppointmentId_key"
ON "invoices"("sourceAppointmentId");
