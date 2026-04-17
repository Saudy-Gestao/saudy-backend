CREATE TABLE "teleconsultation_messages" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "appointmentId" TEXT NOT NULL,
  "fromRole" TEXT NOT NULL,
  "messageType" TEXT NOT NULL,
  "text" TEXT,
  "fileName" TEXT,
  "fileMimeType" TEXT,
  "fileSizeBytes" INTEGER,
  "fileDataUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "teleconsultation_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "teleconsultation_messages_appointmentId_createdAt_idx"
  ON "teleconsultation_messages"("appointmentId", "createdAt");

CREATE INDEX "teleconsultation_messages_branchId_createdAt_idx"
  ON "teleconsultation_messages"("branchId", "createdAt");
