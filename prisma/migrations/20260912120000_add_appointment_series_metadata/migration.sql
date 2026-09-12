ALTER TABLE "appointments"
  ADD COLUMN "insurancePlan" TEXT,
  ADD COLUMN "recurrenceSeriesId" TEXT,
  ADD COLUMN "recurrenceIndex" INTEGER,
  ADD COLUMN "recurrenceTotal" INTEGER,
  ADD COLUMN "simultaneousGroupId" TEXT;

CREATE INDEX "appointments_recurrenceSeriesId_idx" ON "appointments"("recurrenceSeriesId");
CREATE INDEX "appointments_simultaneousGroupId_idx" ON "appointments"("simultaneousGroupId");
