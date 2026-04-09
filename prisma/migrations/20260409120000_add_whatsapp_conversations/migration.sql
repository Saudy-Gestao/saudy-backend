CREATE TYPE "WhatsAppConversationState" AS ENUM (
  'MENU',
  'AWAITING_SERVICE',
  'AWAITING_INSURANCE',
  'AWAITING_PROCEDURE',
  'AWAITING_SLOT_CONFIRMATION',
  'AWAITING_PREFERRED_DATE',
  'AWAITING_CPF',
  'AWAITING_CPF_CONFIRMATION',
  'AWAITING_NEW_PATIENT_NAME',
  'AWAITING_FINAL_CONFIRMATION',
  'COMPLETED',
  'HANDED_OFF'
);

CREATE TABLE "whatsapp_conversations" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "patientId" TEXT,
  "patientName" TEXT,
  "state" "WhatsAppConversationState" NOT NULL DEFAULT 'MENU',
  "selectedService" TEXT,
  "context" JSONB,
  "lastInboundMessage" TEXT,
  "lastOutboundMessage" TEXT,
  "handoffTicketId" TEXT,
  "reservedAppointmentId" TEXT,
  "lastInteractionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "whatsapp_conversations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_conversations_branchId_phone_key"
ON "whatsapp_conversations"("branchId", "phone");

CREATE INDEX "whatsapp_conversations_branchId_idx"
ON "whatsapp_conversations"("branchId");

CREATE INDEX "whatsapp_conversations_patientId_idx"
ON "whatsapp_conversations"("patientId");

CREATE INDEX "whatsapp_conversations_state_idx"
ON "whatsapp_conversations"("state");

CREATE INDEX "whatsapp_conversations_lastInteractionAt_idx"
ON "whatsapp_conversations"("lastInteractionAt");
