-- AlterTable: add email verification fields and verification method to pre_scheduling_flows
ALTER TABLE "pre_scheduling_flows"
  ADD COLUMN "patientVerifiedMethod"      TEXT,
  ADD COLUMN "emailVerificationCode"      TEXT,
  ADD COLUMN "emailVerificationExpiresAt" TIMESTAMP(3),
  ADD COLUMN "emailVerificationAttempts"  INTEGER NOT NULL DEFAULT 0;
