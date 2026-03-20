ALTER TABLE "users"
ADD COLUMN "doctorId" TEXT;

ALTER TABLE "consultations"
ADD COLUMN "doctorId" TEXT,
ADD COLUMN "doctorName" TEXT;

CREATE INDEX "users_doctorId_idx" ON "users"("doctorId");
CREATE INDEX "consultations_doctorId_idx" ON "consultations"("doctorId");

ALTER TABLE "users"
ADD CONSTRAINT "users_doctorId_fkey"
FOREIGN KEY ("doctorId") REFERENCES "doctors"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
