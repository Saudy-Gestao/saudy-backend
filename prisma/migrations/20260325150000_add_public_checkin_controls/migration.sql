ALTER TABLE "branch_settings"
  ADD COLUMN IF NOT EXISTS "publicCheckInEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "publicCheckInLastEnabledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "publicCheckInLastEnabledByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "publicCheckInLastEnabledByName" TEXT,
  ADD COLUMN IF NOT EXISTS "publicCheckInLastDisabledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "publicCheckInLastDisabledByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "publicCheckInLastDisabledByName" TEXT;

CREATE TABLE IF NOT EXISTS "branch_public_check_in_audit_logs" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "performedByUserId" TEXT,
  "performedByName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "branch_public_check_in_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "branch_public_check_in_audit_logs_branchId_createdAt_idx"
  ON "branch_public_check_in_audit_logs" ("branchId", "createdAt");
