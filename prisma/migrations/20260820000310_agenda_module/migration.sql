-- CreateEnum
CREATE TYPE "AgendaStatus" AS ENUM ('ATIVA', 'INATIVA', 'BLOQUEADA');

-- CreateTable
CREATE TABLE "agendas" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "weekday" TEXT NOT NULL,
    "shiftStart" TEXT NOT NULL,
    "shiftEnd" TEXT NOT NULL,
    "especialidadeId" TEXT,
    "roomId" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "status" "AgendaStatus" NOT NULL DEFAULT 'ATIVA',
    "createdByUserId" TEXT,
    "createdByName" TEXT,
    "updatedByUserId" TEXT,
    "updatedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agendas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agendas_branchId_idx" ON "agendas"("branchId");

-- CreateIndex
CREATE INDEX "agendas_doctorId_idx" ON "agendas"("doctorId");

-- CreateIndex
CREATE INDEX "agendas_roomId_idx" ON "agendas"("roomId");

-- CreateIndex
CREATE INDEX "agendas_especialidadeId_idx" ON "agendas"("especialidadeId");

-- CreateIndex
CREATE INDEX "agendas_doctorId_weekday_idx" ON "agendas"("doctorId", "weekday");

-- AddForeignKey
ALTER TABLE "agendas" ADD CONSTRAINT "agendas_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agendas" ADD CONSTRAINT "agendas_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agendas" ADD CONSTRAINT "agendas_especialidadeId_fkey" FOREIGN KEY ("especialidadeId") REFERENCES "especialidades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agendas" ADD CONSTRAINT "agendas_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "sectors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
