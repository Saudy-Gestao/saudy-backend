ALTER TABLE "appointments"
  ADD COLUMN IF NOT EXISTS "inventoryReservedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "inventoryReservationSource" TEXT,
  ADD COLUMN IF NOT EXISTS "inventoryReservationSnapshot" JSONB;
