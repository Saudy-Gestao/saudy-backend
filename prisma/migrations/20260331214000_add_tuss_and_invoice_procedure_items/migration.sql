ALTER TABLE "procedures"
ADD COLUMN "tussCode" TEXT,
ADD COLUMN "tussTableCode" TEXT;

CREATE TABLE "invoice_procedure_items" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "procedureId" TEXT,
  "procedureName" TEXT NOT NULL,
  "tussCode" TEXT,
  "tableCode" TEXT,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "executedAt" TIMESTAMP(3),
  "unitValue" DECIMAL(12,2) NOT NULL,
  "totalValue" DECIMAL(12,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "invoice_procedure_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "invoice_procedure_items_invoiceId_idx" ON "invoice_procedure_items"("invoiceId");
CREATE INDEX "invoice_procedure_items_procedureId_idx" ON "invoice_procedure_items"("procedureId");

ALTER TABLE "invoice_procedure_items"
ADD CONSTRAINT "invoice_procedure_items_invoiceId_fkey"
FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
