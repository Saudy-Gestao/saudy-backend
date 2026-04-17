CREATE TABLE "inventory_kits" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inventory_kits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inventory_kit_items" (
  "id" TEXT NOT NULL,
  "kitId" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inventory_kit_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "procedure_kit_bindings" (
  "id" TEXT NOT NULL,
  "procedureId" TEXT NOT NULL,
  "inventoryKitId" TEXT NOT NULL,
  "insuranceName" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "procedure_kit_bindings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inventory_kit_items_kitId_inventoryItemId_key"
  ON "inventory_kit_items"("kitId", "inventoryItemId");

CREATE INDEX "inventory_kits_isActive_name_idx"
  ON "inventory_kits"("isActive", "name");

CREATE INDEX "inventory_kit_items_kitId_idx"
  ON "inventory_kit_items"("kitId");

CREATE INDEX "inventory_kit_items_inventoryItemId_idx"
  ON "inventory_kit_items"("inventoryItemId");

CREATE INDEX "procedure_kit_bindings_procedureId_insuranceName_isActive_idx"
  ON "procedure_kit_bindings"("procedureId", "insuranceName", "isActive");

CREATE INDEX "procedure_kit_bindings_inventoryKitId_isActive_idx"
  ON "procedure_kit_bindings"("inventoryKitId", "isActive");

ALTER TABLE "inventory_kit_items"
  ADD CONSTRAINT "inventory_kit_items_kitId_fkey"
  FOREIGN KEY ("kitId") REFERENCES "inventory_kits"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inventory_kit_items"
  ADD CONSTRAINT "inventory_kit_items_inventoryItemId_fkey"
  FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "procedure_kit_bindings"
  ADD CONSTRAINT "procedure_kit_bindings_procedureId_fkey"
  FOREIGN KEY ("procedureId") REFERENCES "procedures"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "procedure_kit_bindings"
  ADD CONSTRAINT "procedure_kit_bindings_inventoryKitId_fkey"
  FOREIGN KEY ("inventoryKitId") REFERENCES "inventory_kits"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
