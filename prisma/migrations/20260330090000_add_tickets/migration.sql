CREATE TYPE "TicketType" AS ENUM ('BUG', 'ERROR', 'IMPROVEMENT');
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'TRIAGE', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

CREATE TABLE "tickets" (
    "id" TEXT NOT NULL,
    "flow" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "type" "TicketType" NOT NULL,
    "description" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "createdByUserId" TEXT,
    "createdByName" TEXT,
    "createdByEmail" TEXT,
    "branchId" TEXT,
    "branchName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tickets_status_idx" ON "tickets"("status");
CREATE INDEX "tickets_createdAt_idx" ON "tickets"("createdAt");
CREATE INDEX "tickets_createdByUserId_idx" ON "tickets"("createdByUserId");
CREATE INDEX "tickets_branchId_idx" ON "tickets"("branchId");
