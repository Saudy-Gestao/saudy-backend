CREATE TABLE "tiss_batches" (
    "id" TEXT NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "competenceMonth" TEXT NOT NULL,
    "convention" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "protocolNumber" TEXT,
    "generatedXmlAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "tiss_batches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tiss_batches_batchNumber_key" ON "tiss_batches"("batchNumber");
CREATE INDEX "tiss_batches_status_competenceMonth_idx" ON "tiss_batches"("status", "competenceMonth");
CREATE INDEX "tiss_batches_convention_competenceMonth_idx" ON "tiss_batches"("convention", "competenceMonth");

CREATE TABLE "tiss_batch_items" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "guideNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "tiss_batch_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tiss_batch_items_invoiceId_isActive_key" ON "tiss_batch_items"("invoiceId", "isActive");
CREATE INDEX "tiss_batch_items_batchId_status_idx" ON "tiss_batch_items"("batchId", "status");

ALTER TABLE "tiss_batch_items"
ADD CONSTRAINT "tiss_batch_items_batchId_fkey"
FOREIGN KEY ("batchId") REFERENCES "tiss_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tiss_batch_items"
ADD CONSTRAINT "tiss_batch_items_invoiceId_fkey"
FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
