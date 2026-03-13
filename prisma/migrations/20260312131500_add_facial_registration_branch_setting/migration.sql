ALTER TABLE "branch_settings"
ADD COLUMN IF NOT EXISTS "requireFacialForPatientRegistration" BOOLEAN NOT NULL DEFAULT true;
