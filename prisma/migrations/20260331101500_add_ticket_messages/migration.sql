CREATE TYPE "TicketMessageAuthorRole" AS ENUM ('USER', 'ADMIN', 'SYSTEM');

CREATE TABLE "ticket_messages" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorRole" "TicketMessageAuthorRole" NOT NULL,
    "authorUserId" TEXT,
    "authorName" TEXT,
    "authorEmail" TEXT,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ticket_messages_ticketId_createdAt_idx" ON "ticket_messages"("ticketId", "createdAt");

ALTER TABLE "ticket_messages"
ADD CONSTRAINT "ticket_messages_ticketId_fkey"
FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
