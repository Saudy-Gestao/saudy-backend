ALTER TABLE "doctors" ADD COLUMN "cboId" TEXT;

CREATE INDEX "doctors_cboId_idx" ON "doctors"("cboId");

ALTER TABLE "doctors"
ADD CONSTRAINT "doctors_cboId_fkey"
FOREIGN KEY ("cboId") REFERENCES "cbos"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
