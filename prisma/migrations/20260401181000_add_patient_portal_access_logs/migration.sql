CREATE TABLE "patient_portal_access_logs" (
  "id" TEXT NOT NULL,
  "branchId" TEXT,
  "patientId" TEXT,
  "cpf" TEXT,
  "event" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "ipAddress" TEXT NOT NULL,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "patient_portal_access_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "patient_portal_access_logs_patientId_createdAt_idx" ON "patient_portal_access_logs"("patientId", "createdAt");
CREATE INDEX "patient_portal_access_logs_cpf_createdAt_idx" ON "patient_portal_access_logs"("cpf", "createdAt");
CREATE INDEX "patient_portal_access_logs_event_createdAt_idx" ON "patient_portal_access_logs"("event", "createdAt");
CREATE INDEX "patient_portal_access_logs_status_createdAt_idx" ON "patient_portal_access_logs"("status", "createdAt");
CREATE INDEX "patient_portal_access_logs_branchId_createdAt_idx" ON "patient_portal_access_logs"("branchId", "createdAt");
