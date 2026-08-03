ALTER TABLE "reports"
  ADD COLUMN "finalizedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "reports_finalizedAt_idx" ON "reports"("finalizedAt");
