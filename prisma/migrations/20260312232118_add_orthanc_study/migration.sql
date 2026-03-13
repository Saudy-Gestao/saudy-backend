-- CreateTable
CREATE TABLE "orthanc_studies" (
    "studyUid" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orthanc_studies_pkey" PRIMARY KEY ("studyUid")
);
