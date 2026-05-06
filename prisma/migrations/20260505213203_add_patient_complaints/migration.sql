/*
  Warnings:

  - You are about to drop the column `attachmentBase64` on the `ticket_messages` table. All the data in the column will be lost.

*/
-- AlterEnum
ALTER TYPE "WhatsAppMessageType" ADD VALUE 'EXAM_REPORT_READY';

-- DropForeignKey
ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_inventoryItemId_fkey";

-- AlterTable
ALTER TABLE "pre_scheduling_flows" ADD COLUMN     "patientComplaints" TEXT;

-- AlterTable
ALTER TABLE "ticket_messages" DROP COLUMN "attachmentBase64";

-- AlterTable
ALTER TABLE "whatsapp_conversation_operator_configs" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "whatsapp_conversations" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "patient_portal_dependent_authorizations_dependentPatientId_stat" RENAME TO "patient_portal_dependent_authorizations_dependentPatientId__idx";

-- RenameIndex
ALTER INDEX "patient_portal_dependent_authorizations_guardianCpf_status_star" RENAME TO "patient_portal_dependent_authorizations_guardianCpf_status__idx";

-- RenameIndex
ALTER INDEX "patient_portal_dependent_authorizations_guardianPatientId_statu" RENAME TO "patient_portal_dependent_authorizations_guardianPatientId_s_idx";

-- RenameIndex
ALTER INDEX "procedure_material_kits_procedureId_insuranceName_isDefault_isA" RENAME TO "procedure_material_kits_procedureId_insuranceName_isDefault_idx";
