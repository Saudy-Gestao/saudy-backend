-- AlterTable
ALTER TABLE "patients" ADD COLUMN "image" BYTEA;

-- CreateTable
CREATE TABLE "facial_logs" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trust" DECIMAL(5,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "facial_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "facial_logs_patientId_idx" ON "facial_logs"("patientId");

-- CreateIndex
CREATE INDEX "facial_logs_userId_idx" ON "facial_logs"("userId");

-- CreateIndex
CREATE INDEX "facial_logs_createdAt_idx" ON "facial_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "facial_logs" ADD CONSTRAINT "facial_logs_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
