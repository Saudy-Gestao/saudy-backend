CREATE TABLE "report_publications" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "reportId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "publishedAt" TIMESTAMPTZ(3) NOT NULL,
  "description" TEXT,
  "conclusion" TEXT,
  "notes" TEXT,
  "exam" TEXT,
  "requestingDoctor" TEXT,
  "reportingDoctor" TEXT,
  "reviewingDoctor" TEXT,
  "issuerSignedAt" TIMESTAMPTZ(3),
  "reviewerSignedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "report_publications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "report_publications_reportId_version_key" ON "report_publications"("reportId", "version");
CREATE INDEX "report_publications_branchId_reportId_publishedAt_idx" ON "report_publications"("branchId", "reportId", "publishedAt");

ALTER TABLE "report_publications"
  ADD CONSTRAINT "report_publications_reportId_fkey"
  FOREIGN KEY ("reportId") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "report_publications" (
  "id",
  "branchId",
  "reportId",
  "version",
  "publishedAt",
  "description",
  "conclusion",
  "notes",
  "exam",
  "requestingDoctor",
  "reportingDoctor",
  "reviewingDoctor",
  "issuerSignedAt",
  "reviewerSignedAt",
  "createdAt",
  "updatedAt",
  "isActive"
)
SELECT
  ('pub-' || r."id" || '-' || GREATEST(COALESCE(r."publishedVersion", 0), 1)::text),
  r."branchId",
  r."id",
  GREATEST(COALESCE(r."publishedVersion", 0), 1),
  COALESCE(r."publishedAt", r."updatedAt"),
  r."publishedDescription",
  r."publishedConclusion",
  r."publishedNotes",
  r."publishedExam",
  r."publishedRequestingDoctor",
  r."publishedReportingDoctor",
  r."publishedReviewingDoctor",
  r."publishedIssuerSignedAt",
  r."publishedReviewerSignedAt",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  true
FROM "reports" r
WHERE r."publishedAt" IS NOT NULL;

ALTER TABLE "reports" DROP COLUMN "publishedAt";
ALTER TABLE "reports" DROP COLUMN "publishedVersion";
ALTER TABLE "reports" DROP COLUMN "publishedDescription";
ALTER TABLE "reports" DROP COLUMN "publishedConclusion";
ALTER TABLE "reports" DROP COLUMN "publishedNotes";
ALTER TABLE "reports" DROP COLUMN "publishedExam";
ALTER TABLE "reports" DROP COLUMN "publishedRequestingDoctor";
ALTER TABLE "reports" DROP COLUMN "publishedReportingDoctor";
ALTER TABLE "reports" DROP COLUMN "publishedReviewingDoctor";
ALTER TABLE "reports" DROP COLUMN "publishedIssuerSignedAt";
ALTER TABLE "reports" DROP COLUMN "publishedReviewerSignedAt";
