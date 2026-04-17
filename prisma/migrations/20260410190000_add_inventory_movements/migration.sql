CREATE TABLE "inventory_movements" (
  "id" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "notes" TEXT,
  "previousQty" INTEGER NOT NULL,
  "resultingQty" INTEGER NOT NULL,
  "createdByUserId" TEXT,
  "createdByName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "inventory_movements_inventoryItemId_createdAt_idx"
  ON "inventory_movements"("inventoryItemId", "createdAt");

ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_inventoryItemId_fkey"
  FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
