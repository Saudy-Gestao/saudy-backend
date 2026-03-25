-- CreateTable
CREATE TABLE "medical_equipments" (
    "id" TEXT NOT NULL,
    "branchId" TEXT,
    "roomId" TEXT,
    "name" TEXT NOT NULL,
    "manufacturer" TEXT,
    "model" TEXT,
    "modality" TEXT,
    "integrationType" TEXT NOT NULL DEFAULT 'MWL_BRIDGE',
    "bridgeIdentifier" TEXT,
    "aeTitle" TEXT,
    "remoteAeTitle" TEXT,
    "stationName" TEXT,
    "serialNumber" TEXT,
    "patrimonyCode" TEXT,
    "dicomHost" TEXT,
    "dicomPort" INTEGER,
    "dicomWebPath" TEXT,
    "supportsWorklist" BOOLEAN NOT NULL DEFAULT false,
    "supportsStore" BOOLEAN NOT NULL DEFAULT true,
    "supportsPrint" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'Ativo',
    "observations" TEXT,
    "lastTestStatus" TEXT,
    "lastTestMessage" TEXT,
    "lastTestedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "medical_equipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medical_equipment_procedures" (
    "id" TEXT NOT NULL,
    "medicalEquipmentId" TEXT NOT NULL,
    "procedureId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medical_equipment_procedures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "medical_equipments_branchId_idx" ON "medical_equipments"("branchId");

-- CreateIndex
CREATE INDEX "medical_equipments_roomId_idx" ON "medical_equipments"("roomId");

-- CreateIndex
CREATE INDEX "medical_equipment_procedures_medicalEquipmentId_idx" ON "medical_equipment_procedures"("medicalEquipmentId");

-- CreateIndex
CREATE INDEX "medical_equipment_procedures_procedureId_idx" ON "medical_equipment_procedures"("procedureId");

-- CreateIndex
CREATE UNIQUE INDEX "medical_equipment_procedures_medicalEquipmentId_procedureId_key" ON "medical_equipment_procedures"("medicalEquipmentId", "procedureId");

-- AddForeignKey
ALTER TABLE "medical_equipments" ADD CONSTRAINT "medical_equipments_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "sectors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_equipment_procedures" ADD CONSTRAINT "medical_equipment_procedures_medicalEquipmentId_fkey" FOREIGN KEY ("medicalEquipmentId") REFERENCES "medical_equipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_equipment_procedures" ADD CONSTRAINT "medical_equipment_procedures_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "procedures"("id") ON DELETE CASCADE ON UPDATE CASCADE;
