ALTER TABLE "appointments"
  ADD COLUMN "inventoryConsumptionSource" TEXT,
  ADD COLUMN "inventoryConsumptionSnapshot" JSONB;

CREATE TABLE "procedure_material_kits" (
  "id" TEXT NOT NULL,
  "procedureId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "insuranceName" TEXT,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "procedure_material_kits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "procedure_material_kit_items" (
  "id" TEXT NOT NULL,
  "kitId" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "procedure_material_kit_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "procedure_material_kit_items_kitId_inventoryItemId_key"
  ON "procedure_material_kit_items"("kitId", "inventoryItemId");

CREATE INDEX "procedure_material_kits_procedureId_insuranceName_isDefault_isActive_idx"
  ON "procedure_material_kits"("procedureId", "insuranceName", "isDefault", "isActive");

CREATE INDEX "procedure_material_kit_items_kitId_idx"
  ON "procedure_material_kit_items"("kitId");

CREATE INDEX "procedure_material_kit_items_inventoryItemId_idx"
  ON "procedure_material_kit_items"("inventoryItemId");

ALTER TABLE "procedure_material_kits"
  ADD CONSTRAINT "procedure_material_kits_procedureId_fkey"
  FOREIGN KEY ("procedureId") REFERENCES "procedures"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "procedure_material_kit_items"
  ADD CONSTRAINT "procedure_material_kit_items_kitId_fkey"
  FOREIGN KEY ("kitId") REFERENCES "procedure_material_kits"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "procedure_material_kit_items"
  ADD CONSTRAINT "procedure_material_kit_items_inventoryItemId_fkey"
  FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
