-- AlterTable: Rename twilioSid to providerMessageId in whatsapp_message_logs
-- This migration renames the column to support multiple WhatsApp providers (not just Twilio)

ALTER TABLE "whatsapp_message_logs" 
RENAME COLUMN "twilioSid" TO "providerMessageId";
