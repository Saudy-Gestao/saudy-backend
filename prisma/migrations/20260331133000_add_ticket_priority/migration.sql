CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

ALTER TABLE "tickets"
ADD COLUMN "priority" "TicketPriority" NOT NULL DEFAULT 'MEDIUM';

CREATE INDEX "tickets_priority_idx" ON "tickets"("priority");
