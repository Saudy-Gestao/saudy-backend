ALTER TABLE "reports"
  ADD COLUMN "finalizedDoctorId" TEXT;

CREATE INDEX IF NOT EXISTS "reports_finalizedDoctorId_idx" ON "reports"("finalizedDoctorId");

ALTER TABLE "reports"
  ADD CONSTRAINT "reports_finalizedDoctorId_fkey"
  FOREIGN KEY ("finalizedDoctorId") REFERENCES "doctors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
