-- AlterTable
ALTER TABLE "tea_evolutions"
ADD COLUMN     "appointmentId" TEXT,
ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "lastEditReason" TEXT,
ADD COLUMN     "lastEditedBy" TEXT;

-- CreateIndex
CREATE INDEX "tea_evolutions_appointmentId_idx" ON "tea_evolutions"("appointmentId");

-- AddForeignKey
ALTER TABLE "tea_evolutions"
ADD CONSTRAINT "tea_evolutions_appointmentId_fkey"
FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
