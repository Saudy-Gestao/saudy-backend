CREATE TABLE "whatsapp_conversation_templates" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "createdByUserId" TEXT,
  "createdByName" TEXT,
  "name" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "whatsapp_conversation_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "whatsapp_conversation_templates_companyId_name_idx"
ON "whatsapp_conversation_templates"("companyId", "name");

ALTER TABLE "whatsapp_conversation_templates"
ADD CONSTRAINT "whatsapp_conversation_templates_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "companies"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
