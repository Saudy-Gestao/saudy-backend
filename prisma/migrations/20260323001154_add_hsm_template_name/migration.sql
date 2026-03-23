/*
  Warnings:

  - Made the column `workingSchedules` on table `doctors` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "doctors" ALTER COLUMN "workingSchedules" SET NOT NULL;

-- AlterTable
ALTER TABLE "whatsapp_message_templates" ADD COLUMN     "hsmTemplateName" TEXT;
