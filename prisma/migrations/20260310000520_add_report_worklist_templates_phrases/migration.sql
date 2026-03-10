
-- CreateTable
CREATE TABLE "report_worklist_items" (
    "id" TEXT NOT NULL,
    "externalStudyId" TEXT,
    "accessionNumber" TEXT,
    "patientName" TEXT NOT NULL,
    "patientCpf" TEXT,
    "patientBirthDate" TEXT,
    "examType" TEXT NOT NULL,
    "scheduledAt" TEXT,
    "convenio" TEXT,
    "requestingDoctor" TEXT,
    "assignedTo" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'pendente',
    "reportText" TEXT,
    "issuerSignedAt" TEXT,
    "reviewerSignedAt" TEXT,
    "dicomStudyUid" TEXT,
    "dicomSeriesUid" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "report_worklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "examType" TEXT NOT NULL,
    "group" TEXT,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "report_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_phrases" (
    "id" TEXT NOT NULL,
    "examType" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "report_phrases_pkey" PRIMARY KEY ("id")
);
