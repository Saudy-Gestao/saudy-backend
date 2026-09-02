ALTER TABLE "interns"
  ADD COLUMN "especialidadeId" TEXT,
  ADD COLUMN "workingDays" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "workingHoursStart" TEXT,
  ADD COLUMN "workingHoursEnd" TEXT,
  ADD COLUMN "workingSchedules" TEXT NOT NULL DEFAULT '[]';

CREATE INDEX "interns_especialidadeId_idx" ON "interns"("especialidadeId");

ALTER TABLE "interns"
  ADD CONSTRAINT "interns_especialidadeId_fkey"
  FOREIGN KEY ("especialidadeId") REFERENCES "especialidades"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
