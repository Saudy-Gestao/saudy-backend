-- CreateEnum
CREATE TYPE "PreSchedulingStatus" AS ENUM (
  'PENDING',
  'PRE_AUTHORIZED',
  'LINK_SENT',
  'WAITING_PATIENT_DOCUMENTS',
  'DOCUMENTS_RECEIVED',
  'COMPLETED',
  'CANCELED'
);

-- CreateTable
CREATE TABLE "pre_scheduling_flows" (
  "id" TEXT NOT NULL,
  "branchId" TEXT,
  "appointmentId" TEXT NOT NULL,
  "patientId" TEXT,
  "patientName" TEXT,
  "patientCpf" TEXT,
  "patientPhone" TEXT,
  "status" "PreSchedulingStatus" NOT NULL DEFAULT 'PENDING',
  "preAuthorizedAt" TIMESTAMP(3),
  "guideNumber" TEXT,
  "preAuthorizationNotes" TEXT,
  "publicToken" TEXT NOT NULL,
  "linkSentAt" TIMESTAMP(3),
  "linkSentByUserId" TEXT,
  "linkMockMessage" TEXT,
  "patientVerifiedAt" TIMESTAMP(3),
  "patientVerifiedCpf" TEXT,
  "patientVerifiedName" TEXT,
  "patientVerifiedTrust" DOUBLE PRECISION,
  "patientSubmittedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "pre_scheduling_flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pre_scheduling_documents" (
  "id" TEXT NOT NULL,
  "flowId" TEXT NOT NULL,
  "documentType" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT,
  "sizeBytes" INTEGER,
  "gcsObjectName" TEXT NOT NULL,
  "uploadedByType" TEXT NOT NULL DEFAULT 'PATIENT',
  "uploadedByCpf" TEXT,
  "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pre_scheduling_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pre_scheduling_flows_appointmentId_key" ON "pre_scheduling_flows"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "pre_scheduling_flows_publicToken_key" ON "pre_scheduling_flows"("publicToken");

-- CreateIndex
CREATE INDEX "pre_scheduling_flows_branchId_idx" ON "pre_scheduling_flows"("branchId");

-- CreateIndex
CREATE INDEX "pre_scheduling_flows_status_idx" ON "pre_scheduling_flows"("status");

-- CreateIndex
CREATE INDEX "pre_scheduling_flows_patientCpf_idx" ON "pre_scheduling_flows"("patientCpf");

-- CreateIndex
CREATE INDEX "pre_scheduling_documents_flowId_uploadedAt_idx" ON "pre_scheduling_documents"("flowId", "uploadedAt");

-- AddForeignKey
ALTER TABLE "pre_scheduling_flows"
ADD CONSTRAINT "pre_scheduling_flows_appointmentId_fkey"
FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_scheduling_documents"
ADD CONSTRAINT "pre_scheduling_documents_flowId_fkey"
FOREIGN KEY ("flowId") REFERENCES "pre_scheduling_flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
