ALTER TABLE "appointments"
  ADD COLUMN "doctorId" TEXT,
  ADD COLUMN "agendaId" TEXT;

ALTER TABLE "tea_pre_reservations"
  ADD COLUMN "agendaId" TEXT;

CREATE INDEX "appointments_doctorId_idx" ON "appointments"("doctorId");
CREATE INDEX "appointments_agendaId_idx" ON "appointments"("agendaId");
CREATE INDEX "tea_pre_reservations_agendaId_idx" ON "tea_pre_reservations"("agendaId");

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_doctorId_fkey"
  FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_agendaId_fkey"
  FOREIGN KEY ("agendaId") REFERENCES "agendas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tea_pre_reservations"
  ADD CONSTRAINT "tea_pre_reservations_agendaId_fkey"
  FOREIGN KEY ("agendaId") REFERENCES "agendas"("id") ON DELETE SET NULL ON UPDATE CASCADE;
