CREATE TABLE "patient_portal_dependent_authorizations" (
  "id" TEXT NOT NULL,
  "branchId" TEXT,
  "guardianPatientId" TEXT,
  "guardianCpf" VARCHAR(11) NOT NULL,
  "dependentPatientId" TEXT NOT NULL,
  "dependentCpf" VARCHAR(11) NOT NULL,
  "relationship" TEXT,
  "authorizedByUserId" TEXT,
  "authorizedByName" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "revokedByUserId" TEXT,
  "revokedByName" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "patient_portal_dependent_authorizations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "patient_portal_dependent_authorizations_guardianPatientId_status_startsAt_expiresAt_idx"
  ON "patient_portal_dependent_authorizations"("guardianPatientId", "status", "startsAt", "expiresAt");
CREATE INDEX "patient_portal_dependent_authorizations_guardianCpf_status_startsAt_expiresAt_idx"
  ON "patient_portal_dependent_authorizations"("guardianCpf", "status", "startsAt", "expiresAt");
CREATE INDEX "patient_portal_dependent_authorizations_dependentPatientId_status_idx"
  ON "patient_portal_dependent_authorizations"("dependentPatientId", "status");
CREATE INDEX "patient_portal_dependent_authorizations_dependentCpf_status_idx"
  ON "patient_portal_dependent_authorizations"("dependentCpf", "status");
CREATE INDEX "patient_portal_dependent_authorizations_branchId_status_idx"
  ON "patient_portal_dependent_authorizations"("branchId", "status");
