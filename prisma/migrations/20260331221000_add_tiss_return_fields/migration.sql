ALTER TABLE "tiss_batch_items"
ADD COLUMN "returnStatus" TEXT,
ADD COLUMN "returnCode" TEXT,
ADD COLUMN "returnMessage" TEXT,
ADD COLUMN "glosaValue" DECIMAL(12, 2),
ADD COLUMN "isRepresented" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "representedAt" TIMESTAMP(3);
