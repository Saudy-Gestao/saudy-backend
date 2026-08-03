-- Normalize report/addendum signature and finalization fields to timestamptz.
-- Existing values were generated in UTC in many flows; interpret legacy timestamp values as UTC.

ALTER TABLE "reports"
  ALTER COLUMN "issuerSignedAt" TYPE TIMESTAMPTZ(3) USING "issuerSignedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "reviewerSignedAt" TYPE TIMESTAMPTZ(3) USING "reviewerSignedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "finalizedAt" TYPE TIMESTAMPTZ(3) USING "finalizedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "publishedAt" TYPE TIMESTAMPTZ(3) USING "publishedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "publishedIssuerSignedAt" TYPE TIMESTAMPTZ(3) USING "publishedIssuerSignedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "publishedReviewerSignedAt" TYPE TIMESTAMPTZ(3) USING "publishedReviewerSignedAt" AT TIME ZONE 'UTC';

ALTER TABLE "report_addendums"
  ALTER COLUMN "issuerSignedAt" TYPE TIMESTAMPTZ(3) USING "issuerSignedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "reviewerSignedAt" TYPE TIMESTAMPTZ(3) USING "reviewerSignedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "finalizedAt" TYPE TIMESTAMPTZ(3) USING "finalizedAt" AT TIME ZONE 'UTC';

ALTER TABLE "report_addendums"
  ALTER COLUMN "savedAt" TYPE TIMESTAMPTZ(3)
  USING (CASE WHEN "savedAt" IS NULL OR btrim("savedAt") = '' THEN NULL ELSE "savedAt"::timestamptz END);
