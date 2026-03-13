-- CreateTable
CREATE TABLE "sub_insurances" (
    "id" TEXT NOT NULL,
    "branchId" TEXT,
    "insuranceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sub_insurances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sub_insurances_insuranceId_name_key" ON "sub_insurances"("insuranceId", "name");
CREATE INDEX "sub_insurances_branchId_idx" ON "sub_insurances"("branchId");
CREATE INDEX "sub_insurances_insuranceId_idx" ON "sub_insurances"("insuranceId");

-- AddForeignKey
ALTER TABLE "sub_insurances"
ADD CONSTRAINT "sub_insurances_insuranceId_fkey"
FOREIGN KEY ("insuranceId") REFERENCES "insurances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
