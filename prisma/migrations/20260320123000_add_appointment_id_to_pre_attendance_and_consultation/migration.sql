-- Add deterministic appointment linkage to reception and clinical queue
ALTER TABLE "pre_attendances"
  ADD COLUMN IF NOT EXISTS "appointmentId" TEXT;

ALTER TABLE "consultations"
  ADD COLUMN IF NOT EXISTS "appointmentId" TEXT;

CREATE INDEX IF NOT EXISTS "pre_attendances_appointmentId_idx"
  ON "pre_attendances" ("appointmentId");

CREATE INDEX IF NOT EXISTS "consultations_appointmentId_idx"
  ON "consultations" ("appointmentId");
