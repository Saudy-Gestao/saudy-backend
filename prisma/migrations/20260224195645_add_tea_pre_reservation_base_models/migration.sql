-- CreateEnum
CREATE TYPE "TeaPreReservationStatus" AS ENUM ('PENDING_SCHEDULING', 'PROPOSED', 'RESERVED', 'PENDING_AUTHORIZATION', 'AUTHORIZED', 'CONVERTED', 'EXPIRED', 'CANCELED');

-- CreateTable
CREATE TABLE "tea_pre_reservations" (
    "id" TEXT NOT NULL,
    "teaProfileId" TEXT NOT NULL,
    "pitId" TEXT NOT NULL,
    "pitTherapyId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "procedureId" TEXT,
    "procedureName" TEXT,
    "professionalDoctorId" TEXT,
    "professionalName" TEXT,
    "suggestedDate" TIMESTAMP(3),
    "suggestedTime" TEXT,
    "status" "TeaPreReservationStatus" NOT NULL DEFAULT 'PENDING_SCHEDULING',
    "notes" TEXT,
    "expiresAt" TIMESTAMP(3),
    "authorizedAt" TIMESTAMP(3),
    "convertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tea_pre_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tea_pre_reservations_status_idx" ON "tea_pre_reservations"("status");

-- CreateIndex
CREATE INDEX "tea_pre_reservations_pitTherapyId_status_idx" ON "tea_pre_reservations"("pitTherapyId", "status");

-- CreateIndex
CREATE INDEX "tea_pre_reservations_patientId_idx" ON "tea_pre_reservations"("patientId");

-- AddForeignKey
ALTER TABLE "tea_pre_reservations" ADD CONSTRAINT "tea_pre_reservations_teaProfileId_fkey" FOREIGN KEY ("teaProfileId") REFERENCES "tea_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tea_pre_reservations" ADD CONSTRAINT "tea_pre_reservations_pitId_fkey" FOREIGN KEY ("pitId") REFERENCES "tea_pits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tea_pre_reservations" ADD CONSTRAINT "tea_pre_reservations_pitTherapyId_fkey" FOREIGN KEY ("pitTherapyId") REFERENCES "tea_pit_therapies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tea_pre_reservations" ADD CONSTRAINT "tea_pre_reservations_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
