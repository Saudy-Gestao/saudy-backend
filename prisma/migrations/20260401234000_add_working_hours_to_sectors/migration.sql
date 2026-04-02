-- Add room working schedule fields
ALTER TABLE "sectors"
  ADD COLUMN "workingDays" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "workingHoursStart" TEXT,
  ADD COLUMN "workingHoursEnd" TEXT;
