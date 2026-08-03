ALTER TABLE "reports"
  ADD COLUMN "publishedAt" TIMESTAMP(3),
  ADD COLUMN "publishedVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "publishedDescription" TEXT,
  ADD COLUMN "publishedConclusion" TEXT,
  ADD COLUMN "publishedNotes" TEXT,
  ADD COLUMN "publishedExam" TEXT,
  ADD COLUMN "publishedRequestingDoctor" TEXT,
  ADD COLUMN "publishedReportingDoctor" TEXT,
  ADD COLUMN "publishedReviewingDoctor" TEXT,
  ADD COLUMN "publishedIssuerSignedAt" TIMESTAMP(3),
  ADD COLUMN "publishedReviewerSignedAt" TIMESTAMP(3);
