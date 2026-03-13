-- CreateTable
CREATE TABLE "procedure_materials" (
    "id" TEXT NOT NULL,
    "procedureId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "procedure_materials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "procedure_materials_procedureId_inventoryItemId_key" ON "procedure_materials"("procedureId", "inventoryItemId");

-- CreateIndex
CREATE INDEX "procedure_materials_procedureId_idx" ON "procedure_materials"("procedureId");

-- CreateIndex
CREATE INDEX "procedure_materials_inventoryItemId_idx" ON "procedure_materials"("inventoryItemId");

-- AddForeignKey
ALTER TABLE "procedure_materials" ADD CONSTRAINT "procedure_materials_procedureId_fkey" FOREIGN KEY ("procedureId") REFERENCES "procedures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procedure_materials" ADD CONSTRAINT "procedure_materials_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
