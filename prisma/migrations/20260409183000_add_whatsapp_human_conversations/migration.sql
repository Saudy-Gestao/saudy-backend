CREATE TYPE "WhatsAppHumanConversationStatus" AS ENUM ('QUEUED', 'ASSIGNED', 'CLOSED');
CREATE TYPE "WhatsAppConversationMessageAuthorType" AS ENUM ('PATIENT', 'BOT', 'OPERATOR', 'SYSTEM');

ALTER TABLE "whatsapp_conversations"
ADD COLUMN "humanStatus" "WhatsAppHumanConversationStatus",
ADD COLUMN "humanFlowKey" TEXT,
ADD COLUMN "humanFlowLabel" TEXT,
ADD COLUMN "humanAssignedUserId" TEXT,
ADD COLUMN "humanAssignedUserName" TEXT,
ADD COLUMN "humanAssignedAt" TIMESTAMP(3),
ADD COLUMN "humanClosedAt" TIMESTAMP(3),
ADD COLUMN "humanClosedByUserId" TEXT,
ADD COLUMN "humanClosedByUserName" TEXT;

CREATE INDEX "whatsapp_conversations_humanStatus_idx"
ON "whatsapp_conversations"("humanStatus");

CREATE INDEX "whatsapp_conversations_humanAssignedUserId_idx"
ON "whatsapp_conversations"("humanAssignedUserId");

CREATE INDEX "whatsapp_conversations_humanFlowKey_idx"
ON "whatsapp_conversations"("humanFlowKey");

CREATE TABLE "whatsapp_conversation_messages" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "flowKey" TEXT,
  "authorType" "WhatsAppConversationMessageAuthorType" NOT NULL,
  "authorUserId" TEXT,
  "authorName" TEXT,
  "message" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "whatsapp_conversation_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "whatsapp_conversation_messages_conversationId_createdAt_idx"
ON "whatsapp_conversation_messages"("conversationId", "createdAt");

CREATE INDEX "whatsapp_conversation_messages_branchId_createdAt_idx"
ON "whatsapp_conversation_messages"("branchId", "createdAt");

CREATE INDEX "whatsapp_conversation_messages_phone_createdAt_idx"
ON "whatsapp_conversation_messages"("phone", "createdAt");

ALTER TABLE "whatsapp_conversation_messages"
ADD CONSTRAINT "whatsapp_conversation_messages_conversationId_fkey"
FOREIGN KEY ("conversationId") REFERENCES "whatsapp_conversations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "whatsapp_conversation_operator_configs" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "flowKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "maxActiveConversations" INTEGER NOT NULL DEFAULT 3,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "whatsapp_conversation_operator_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_conversation_operator_configs_userId_key"
ON "whatsapp_conversation_operator_configs"("userId");

CREATE INDEX "whatsapp_conversation_operator_configs_isActive_idx"
ON "whatsapp_conversation_operator_configs"("isActive");
