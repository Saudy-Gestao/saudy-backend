ALTER TABLE "report_addendums"
  ADD COLUMN "issuerDoctorId" TEXT,
  ADD COLUMN "issuerDoctor" TEXT;

CREATE INDEX "report_addendums_issuerDoctorId_idx" ON "report_addendums"("issuerDoctorId");
