/*
  Warnings:

  - A unique constraint covering the columns `[instanceId]` on the table `dicom_files` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "dicom_files" ADD COLUMN     "instanceId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "dicom_files_instanceId_key" ON "dicom_files"("instanceId");
