CREATE TABLE "temporary_dicom_studies" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "orthancStudyId" TEXT NOT NULL,
    "studyInstanceUid" TEXT NOT NULL,
    "patientName" TEXT,
    "patientId" TEXT,
    "modality" TEXT,
    "studyDate" TEXT,
    "description" TEXT,
    "instancesCount" INTEGER NOT NULL DEFAULT 0,
    "uploadedByUserId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "deleteFromOrthanc" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "temporary_dicom_studies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "temporary_dicom_studies_branchId_idx" ON "temporary_dicom_studies"("branchId");
CREATE INDEX "temporary_dicom_studies_reportId_idx" ON "temporary_dicom_studies"("reportId");
CREATE INDEX "temporary_dicom_studies_expiresAt_deletedAt_idx" ON "temporary_dicom_studies"("expiresAt", "deletedAt");

ALTER TABLE "temporary_dicom_studies"
ADD CONSTRAINT "temporary_dicom_studies_reportId_fkey"
FOREIGN KEY ("reportId") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
