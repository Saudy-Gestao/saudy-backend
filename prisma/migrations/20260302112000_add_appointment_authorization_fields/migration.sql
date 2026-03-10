-- Authorization tracking for convenio on appointments
ALTER TABLE "appointments"
ADD COLUMN "authorizationStatus" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN "authorizationNotes" TEXT,
ADD COLUMN "authorizedAt" TIMESTAMP(3);
