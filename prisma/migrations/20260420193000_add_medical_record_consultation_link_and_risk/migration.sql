ALTER TABLE "medical_records"
ADD COLUMN "consultationId" TEXT,
ADD COLUMN "riskClassification" TEXT;

CREATE UNIQUE INDEX "medical_records_consultationId_key"
ON "medical_records"("consultationId");

ALTER TABLE "medical_records"
ADD CONSTRAINT "medical_records_consultationId_fkey"
FOREIGN KEY ("consultationId") REFERENCES "consultations"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
