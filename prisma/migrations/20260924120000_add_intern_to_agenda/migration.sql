ALTER TABLE "agendas"
  ADD COLUMN "internId" TEXT;

CREATE INDEX "agendas_internId_idx" ON "agendas"("internId");

CREATE INDEX "agendas_doctorId_internId_weekday_idx" ON "agendas"("doctorId", "internId", "weekday");

ALTER TABLE "agendas"
  ADD CONSTRAINT "agendas_internId_fkey"
  FOREIGN KEY ("internId") REFERENCES "interns"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
