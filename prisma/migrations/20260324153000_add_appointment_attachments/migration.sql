CREATE TABLE IF NOT EXISTS "appointment_attachments" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "gcsObjectName" TEXT NOT NULL,
    "uploadedByUserId" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "appointment_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "appointment_attachments_branchId_idx" ON "appointment_attachments"("branchId");
CREATE INDEX IF NOT EXISTS "appointment_attachments_appointmentId_idx" ON "appointment_attachments"("appointmentId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'appointment_attachments_appointmentId_fkey'
      AND table_name = 'appointment_attachments'
  ) THEN
    ALTER TABLE "appointment_attachments"
      ADD CONSTRAINT "appointment_attachments_appointmentId_fkey"
      FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
