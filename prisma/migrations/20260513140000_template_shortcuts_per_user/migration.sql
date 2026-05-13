-- Drop shortcut column from shared templates table (shortcut is per-user, not per-template)
ALTER TABLE "whatsapp_conversation_templates" DROP COLUMN IF EXISTS "shortcut";

-- Per-user shortcut mapping: each operator can assign their own keyboard shortcut to any template
CREATE TABLE "whatsapp_template_shortcuts" (
    "id"         TEXT NOT NULL,
    "userId"     TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "shortcut"   TEXT NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_template_shortcuts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "whatsapp_template_shortcuts_userId_templateId_key" UNIQUE ("userId", "templateId"),
    CONSTRAINT "whatsapp_template_shortcuts_userId_shortcut_key" UNIQUE ("userId", "shortcut")
);

CREATE INDEX "whatsapp_template_shortcuts_userId_idx" ON "whatsapp_template_shortcuts"("userId");
