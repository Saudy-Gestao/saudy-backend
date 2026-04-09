ALTER TYPE "WhatsAppConversationState" ADD VALUE IF NOT EXISTS 'AWAITING_PROCEDURE_NOT_FOUND_ACTION';
ALTER TYPE "WhatsAppConversationState" ADD VALUE IF NOT EXISTS 'AWAITING_PRIVATE_PROCEDURE_INPUT';
ALTER TYPE "WhatsAppConversationState" ADD VALUE IF NOT EXISTS 'AWAITING_PRIVATE_PROCEDURE_CONFIRMATION';
ALTER TYPE "WhatsAppConversationState" ADD VALUE IF NOT EXISTS 'AWAITING_PRIVATE_PROCEDURE_MATCH_CONFIRMATION';

ALTER TABLE "whatsapp_conversations"
ADD COLUMN "humanProtocolNumber" TEXT,
ADD COLUMN "humanProtocolStartedAt" TIMESTAMP(3),
ADD COLUMN "humanProtocolClosedAt" TIMESTAMP(3),
ADD COLUMN "humanIdleWarningSentAt" TIMESTAMP(3),
ADD COLUMN "humanLastOperatorMessageAt" TIMESTAMP(3),
ADD COLUMN "humanLastPatientMessageAt" TIMESTAMP(3);

ALTER TABLE "whatsapp_conversation_messages"
ADD COLUMN "providerMessageId" TEXT,
ADD COLUMN "metadata" JSONB;

ALTER TABLE "whatsapp_conversation_operator_configs"
ADD COLUMN "idleTimeoutMinutes" INTEGER NOT NULL DEFAULT 25,
ADD COLUMN "closeWarningMinutes" INTEGER NOT NULL DEFAULT 5;

CREATE INDEX "whatsapp_conversation_messages_providerMessageId_idx"
ON "whatsapp_conversation_messages"("providerMessageId");
