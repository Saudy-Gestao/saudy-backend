CREATE TABLE "whatsapp_conversation_media" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "appointmentId" TEXT,
    "mediaType" TEXT NOT NULL,
    "mediaUrl" TEXT,
    "fileName" TEXT,
    "mimeType" TEXT,
    "mediaId" TEXT,
    "providerMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_conversation_media_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "whatsapp_conversation_media_conversationId_createdAt_idx" ON "whatsapp_conversation_media"("conversationId", "createdAt");
CREATE INDEX "whatsapp_conversation_media_appointmentId_idx" ON "whatsapp_conversation_media"("appointmentId");

ALTER TABLE "whatsapp_conversation_media" ADD CONSTRAINT "whatsapp_conversation_media_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "whatsapp_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
