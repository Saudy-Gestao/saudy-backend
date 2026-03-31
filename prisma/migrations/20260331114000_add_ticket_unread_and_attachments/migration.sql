ALTER TABLE "tickets"
ADD COLUMN "lastUserMessageAt" TIMESTAMP(3),
ADD COLUMN "lastAdminMessageAt" TIMESTAMP(3),
ADD COLUMN "lastReadByUserAt" TIMESTAMP(3),
ADD COLUMN "lastReadByAdminAt" TIMESTAMP(3);

ALTER TABLE "ticket_messages"
ADD COLUMN "attachmentName" TEXT,
ADD COLUMN "attachmentMimeType" TEXT,
ADD COLUMN "attachmentSizeBytes" INTEGER,
ADD COLUMN "attachmentBase64" TEXT;
