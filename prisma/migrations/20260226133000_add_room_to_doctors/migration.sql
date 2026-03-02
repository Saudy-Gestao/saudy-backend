-- Add optional room (sector) link to doctors
ALTER TABLE "doctors"
ADD COLUMN "roomId" TEXT;

ALTER TABLE "doctors"
ADD CONSTRAINT "doctors_roomId_fkey"
FOREIGN KEY ("roomId") REFERENCES "sectors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "doctors_roomId_idx" ON "doctors"("roomId");
