-- Add the clinical specialty link used to classify procedures.
ALTER TABLE "procedures" ADD COLUMN "especialidadeId" TEXT;

CREATE INDEX "procedures_especialidadeId_idx" ON "procedures"("especialidadeId");

ALTER TABLE "procedures"
  ADD CONSTRAINT "procedures_especialidadeId_fkey"
  FOREIGN KEY ("especialidadeId") REFERENCES "especialidades"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
