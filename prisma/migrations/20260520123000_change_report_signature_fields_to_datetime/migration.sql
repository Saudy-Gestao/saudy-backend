-- Recreate signature timestamp columns without legacy string conversion.
ALTER TABLE "reports"
  DROP COLUMN "issuerSignedAt",
  DROP COLUMN "reviewerSignedAt";

ALTER TABLE "reports"
  ADD COLUMN "issuerSignedAt" TIMESTAMP(3),
  ADD COLUMN "reviewerSignedAt" TIMESTAMP(3);
