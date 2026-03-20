CREATE TABLE IF NOT EXISTS "convenio_authorization_attachments" (
  "id" TEXT PRIMARY KEY,
  "branchId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "appointmentId" TEXT,
  "pitTherapyId" TEXT,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT,
  "sizeBytes" INTEGER,
  "gcsObjectName" TEXT NOT NULL,
  "uploadedByUserId" TEXT,
  "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "isActive" BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS "convenio_authorization_attachments_branchId_sourceType_idx"
  ON "convenio_authorization_attachments" ("branchId", "sourceType");

CREATE INDEX IF NOT EXISTS "convenio_authorization_attachments_appointmentId_idx"
  ON "convenio_authorization_attachments" ("appointmentId");

CREATE INDEX IF NOT EXISTS "convenio_authorization_attachments_pitTherapyId_idx"
  ON "convenio_authorization_attachments" ("pitTherapyId");
