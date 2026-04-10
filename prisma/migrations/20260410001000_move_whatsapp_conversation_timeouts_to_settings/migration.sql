CREATE TABLE "whatsapp_conversation_settings" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "idleTimeoutMinutes" INTEGER NOT NULL DEFAULT 25,
  "closeWarningMinutes" INTEGER NOT NULL DEFAULT 5,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "whatsapp_conversation_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_conversation_settings_branchId_key" ON "whatsapp_conversation_settings"("branchId");
CREATE INDEX "whatsapp_conversation_settings_branchId_idx" ON "whatsapp_conversation_settings"("branchId");

INSERT INTO "whatsapp_conversation_settings" ("id", "branchId", "idleTimeoutMinutes", "closeWarningMinutes", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  c."branchId",
  COALESCE(MAX(cfg."idleTimeoutMinutes"), 25),
  COALESCE(MAX(cfg."closeWarningMinutes"), 5),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "whatsapp_conversations" c
LEFT JOIN "whatsapp_conversation_operator_configs" cfg
  ON cfg."userId" = c."humanAssignedUserId"
GROUP BY c."branchId"
ON CONFLICT ("branchId") DO NOTHING;

ALTER TABLE "whatsapp_conversation_operator_configs"
DROP COLUMN "idleTimeoutMinutes",
DROP COLUMN "closeWarningMinutes";
