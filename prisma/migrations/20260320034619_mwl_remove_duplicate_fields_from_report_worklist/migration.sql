/*
  Warnings:

  - You are about to drop the column `assignedTo` on the `report_worklist_items` table. All the data in the column will be lost.
  - You are about to drop the column `convenio` on the `report_worklist_items` table. All the data in the column will be lost.
  - You are about to drop the column `examType` on the `report_worklist_items` table. All the data in the column will be lost.
  - You are about to drop the column `issuerSignedAt` on the `report_worklist_items` table. All the data in the column will be lost.
  - You are about to drop the column `patientBirthDate` on the `report_worklist_items` table. All the data in the column will be lost.
  - You are about to drop the column `patientName` on the `report_worklist_items` table. All the data in the column will be lost.
  - You are about to drop the column `priority` on the `report_worklist_items` table. All the data in the column will be lost.
  - You are about to drop the column `reportText` on the `report_worklist_items` table. All the data in the column will be lost.
  - You are about to drop the column `requestingDoctor` on the `report_worklist_items` table. All the data in the column will be lost.
  - You are about to drop the column `reviewerSignedAt` on the `report_worklist_items` table. All the data in the column will be lost.
  - You are about to drop the column `scheduledAt` on the `report_worklist_items` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `report_worklist_items` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "report_worklist_items" DROP COLUMN "assignedTo",
DROP COLUMN "convenio",
DROP COLUMN "examType",
DROP COLUMN "issuerSignedAt",
DROP COLUMN "patientBirthDate",
DROP COLUMN "patientName",
DROP COLUMN "priority",
DROP COLUMN "reportText",
DROP COLUMN "requestingDoctor",
DROP COLUMN "reviewerSignedAt",
DROP COLUMN "scheduledAt",
DROP COLUMN "status";
