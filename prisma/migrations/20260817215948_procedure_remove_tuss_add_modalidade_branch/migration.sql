/*
  Warnings:

  - You are about to drop the column `tussCode` on the `procedures` table. All the data in the column will be lost.
  - You are about to drop the column `tussTableCode` on the `procedures` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "procedures" DROP COLUMN "tussCode",
DROP COLUMN "tussTableCode",
ADD COLUMN     "branchIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "modalidadeId" TEXT;

-- CreateIndex
CREATE INDEX "procedures_modalidadeId_idx" ON "procedures"("modalidadeId");

-- AddForeignKey
ALTER TABLE "procedures" ADD CONSTRAINT "procedures_modalidadeId_fkey" FOREIGN KEY ("modalidadeId") REFERENCES "modalidades"("id") ON DELETE SET NULL ON UPDATE CASCADE;
