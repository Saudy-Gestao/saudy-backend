ALTER TABLE "invoices"
ADD COLUMN "packageValue" DECIMAL(12, 2),
ADD COLUMN "materialsValue" DECIMAL(12, 2),
ADD COLUMN "feesValue" DECIMAL(12, 2),
ADD COLUMN "dailyValue" DECIMAL(12, 2),
ADD COLUMN "gasesValue" DECIMAL(12, 2),
ADD COLUMN "opmeValue" DECIMAL(12, 2),
ADD COLUMN "expectedDiscountValue" DECIMAL(12, 2),
ADD COLUMN "expectedGlosaValue" DECIMAL(12, 2);
