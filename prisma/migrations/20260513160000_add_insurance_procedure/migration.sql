-- CreateTable
CREATE TABLE "insurance_procedures" (
    "id" TEXT NOT NULL,
    "insuranceId" TEXT NOT NULL,
    "subInsuranceId" TEXT,
    "procedureId" TEXT NOT NULL,
    "price" DECIMAL(10,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insurance_procedures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "insurance_procedures_insuranceId_idx" ON "insurance_procedures"("insuranceId");

-- CreateIndex
CREATE INDEX "insurance_procedures_procedureId_idx" ON "insurance_procedures"("procedureId");

-- CreateIndex
CREATE UNIQUE INDEX "insurance_procedures_insuranceId_subInsuranceId_procedureId_key" ON "insurance_procedures"("insuranceId", "subInsuranceId", "procedureId");

-- AddForeignKey
ALTER TABLE "insurance_procedures" ADD CONSTRAINT "insurance_procedures_insuranceId_fkey" FOREIGN KEY ("insuranceId") REFERENCES "insurances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_procedures" ADD CONSTRAINT "insurance_procedures_subInsuranceId_fkey" FOREIGN KEY ("subInsuranceId") REFERENCES "sub_insurances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_procedures" ADD CONSTRAINT "insurance_procedures_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "procedures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: remove acceptsInsurance and acceptedInsurances from procedures
ALTER TABLE "procedures" DROP COLUMN IF EXISTS "acceptsInsurance";
ALTER TABLE "procedures" DROP COLUMN IF EXISTS "acceptedInsurances";
