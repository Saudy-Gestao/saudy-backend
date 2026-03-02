-- CreateTable
CREATE TABLE "tea_pre_reservation_timeline" (
    "id" TEXT NOT NULL,
    "preReservationId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventLabel" TEXT NOT NULL,
    "actor" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tea_pre_reservation_timeline_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tea_pre_reservation_timeline_preReservationId_createdAt_idx" ON "tea_pre_reservation_timeline"("preReservationId", "createdAt");

-- AddForeignKey
ALTER TABLE "tea_pre_reservation_timeline" ADD CONSTRAINT "tea_pre_reservation_timeline_preReservationId_fkey" FOREIGN KEY ("preReservationId") REFERENCES "tea_pre_reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
