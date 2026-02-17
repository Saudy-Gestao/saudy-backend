/*
  Warnings:

  - Made the column `patientName` on table `reports` required. This step will fail if there are existing NULL values in that column.

*/
-- Ensure no NULLs remain (normalize existing data)
UPDATE "reports" SET "patientName" = 'Paciente desconhecido' WHERE "patientName" IS NULL;

-- AlterTable
ALTER TABLE "reports" ALTER COLUMN "patientName" SET NOT NULL;
