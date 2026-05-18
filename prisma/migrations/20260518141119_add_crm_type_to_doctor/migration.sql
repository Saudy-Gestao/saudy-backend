-- AlterTable
ALTER TABLE "doctors" ADD COLUMN     "crmType" TEXT NOT NULL DEFAULT 'CRM';

-- AlterTable
ALTER TABLE "whatsapp_template_shortcuts" ALTER COLUMN "updatedAt" DROP DEFAULT;
