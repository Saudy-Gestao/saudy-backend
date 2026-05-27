ALTER TABLE "reports"
  ADD COLUMN "reportingDoctorId" TEXT,
  ADD COLUMN "reviewingDoctorId" TEXT;

CREATE INDEX IF NOT EXISTS "reports_reportingDoctorId_idx" ON "reports"("reportingDoctorId");
CREATE INDEX IF NOT EXISTS "reports_reviewingDoctorId_idx" ON "reports"("reviewingDoctorId");

ALTER TABLE "reports"
  ADD CONSTRAINT "reports_reportingDoctorId_fkey"
  FOREIGN KEY ("reportingDoctorId") REFERENCES "doctors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "reports"
  ADD CONSTRAINT "reports_reviewingDoctorId_fkey"
  FOREIGN KEY ("reviewingDoctorId") REFERENCES "doctors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
