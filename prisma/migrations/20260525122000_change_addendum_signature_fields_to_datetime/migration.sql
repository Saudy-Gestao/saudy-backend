ALTER TABLE "report_addendums"
  ALTER COLUMN "issuerSignedAt" TYPE TIMESTAMP(3) USING ("issuerSignedAt"::timestamp),
  ALTER COLUMN "reviewerSignedAt" TYPE TIMESTAMP(3) USING ("reviewerSignedAt"::timestamp),
  ALTER COLUMN "finalizedAt" TYPE TIMESTAMP(3) USING ("finalizedAt"::timestamp);
