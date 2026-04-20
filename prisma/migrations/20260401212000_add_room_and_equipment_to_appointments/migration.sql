-- AlterTable
ALTER TABLE "appointments"
ADD COLUMN "roomId" TEXT,
ADD COLUMN "medicalEquipmentId" TEXT;

-- CreateIndex
CREATE INDEX "appointments_roomId_idx" ON "appointments"("roomId");

-- CreateIndex
CREATE INDEX "appointments_medicalEquipmentId_idx" ON "appointments"("medicalEquipmentId");
