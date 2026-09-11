-- AlterTable
ALTER TABLE "tea_pre_reservations" ADD COLUMN "roomId" TEXT,
ADD COLUMN "roomName" TEXT;

-- CreateIndex
CREATE INDEX "tea_pre_reservations_roomId_idx" ON "tea_pre_reservations"("roomId");
