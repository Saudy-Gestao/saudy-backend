/*
  Warnings:

  - You are about to drop the column `cbo` on the `doctors` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "doctors" DROP COLUMN "cbo";

-- AlterTable
ALTER TABLE "especialidades" ADD COLUMN     "cboId" TEXT;

-- CreateTable
CREATE TABLE "cbos" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cbos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cbos_code_key" ON "cbos"("code");

-- CreateIndex
CREATE INDEX "especialidades_cboId_idx" ON "especialidades"("cboId");

-- AddForeignKey
ALTER TABLE "especialidades" ADD CONSTRAINT "especialidades_cboId_fkey" FOREIGN KEY ("cboId") REFERENCES "cbos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
