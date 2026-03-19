ALTER TABLE "pre_attendances"
ADD COLUMN "doctorId" TEXT,
ADD COLUMN "doctorName" TEXT;

CREATE INDEX "pre_attendances_doctorId_idx" ON "pre_attendances"("doctorId");
