DO $$
BEGIN
  ALTER TYPE "WhatsAppConversationState" ADD VALUE 'AWAITING_UNIT';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
