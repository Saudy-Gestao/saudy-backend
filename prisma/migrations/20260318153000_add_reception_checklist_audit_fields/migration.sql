ALTER TABLE "pre_attendances"
ADD COLUMN "checklistStartedAt" TIMESTAMP(3),
ADD COLUMN "checklistCompletedAt" TIMESTAMP(3),
ADD COLUMN "finalFacialValidationAt" TIMESTAMP(3),
ADD COLUMN "finalFacialValidationStatus" TEXT,
ADD COLUMN "finalFacialValidationTrust" DOUBLE PRECISION,
ADD COLUMN "finalFacialValidationName" TEXT,
ADD COLUMN "finalFacialValidationCpf" TEXT;
