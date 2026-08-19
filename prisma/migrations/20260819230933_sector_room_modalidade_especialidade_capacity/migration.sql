-- AlterTable
ALTER TABLE "sectors" ADD COLUMN     "capacity" INTEGER,
ADD COLUMN     "especialidadeId" TEXT,
ADD COLUMN     "modalidadeId" TEXT;

-- CreateIndex
CREATE INDEX "sectors_modalidadeId_idx" ON "sectors"("modalidadeId");

-- CreateIndex
CREATE INDEX "sectors_especialidadeId_idx" ON "sectors"("especialidadeId");

-- AddForeignKey
ALTER TABLE "sectors" ADD CONSTRAINT "sectors_modalidadeId_fkey" FOREIGN KEY ("modalidadeId") REFERENCES "modalidades"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sectors" ADD CONSTRAINT "sectors_especialidadeId_fkey" FOREIGN KEY ("especialidadeId") REFERENCES "especialidades"("id") ON DELETE SET NULL ON UPDATE CASCADE;
