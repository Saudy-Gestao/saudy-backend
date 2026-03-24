ALTER TABLE "appointments"
ADD COLUMN IF NOT EXISTS "rescheduledFromAppointmentId" TEXT;

CREATE INDEX IF NOT EXISTS "appointments_rescheduledFromAppointmentId_idx" ON "appointments"("rescheduledFromAppointmentId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'appointments_rescheduledFromAppointmentId_fkey'
      AND table_name = 'appointments'
  ) THEN
    ALTER TABLE "appointments"
    ADD CONSTRAINT "appointments_rescheduledFromAppointmentId_fkey"
    FOREIGN KEY ("rescheduledFromAppointmentId") REFERENCES "appointments"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
