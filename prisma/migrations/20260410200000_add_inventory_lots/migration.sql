CREATE TABLE "inventory_lots" (
  "id" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "lotCode" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "expiryDate" TIMESTAMP(3),
  "unitPrice" DECIMAL(12,2),
  "supplier" TEXT,
  "notes" TEXT,
  "createdByUserId" TEXT,
  "createdByName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inventory_lots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_lots_inventoryItemId_lotCode_key"
  ON "inventory_lots"("inventoryItemId", "lotCode");

CREATE INDEX "inventory_lots_inventoryItemId_expiryDate_idx"
  ON "inventory_lots"("inventoryItemId", "expiryDate");

ALTER TABLE "inventory_lots"
  ADD CONSTRAINT "inventory_lots_inventoryItemId_fkey"
  FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
