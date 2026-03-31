ALTER TABLE "invoices"
ADD COLUMN "beneficiaryCardNumber" TEXT,
ADD COLUMN "beneficiaryPlan" TEXT,
ADD COLUMN "beneficiaryCardExpiry" TEXT,
ADD COLUMN "beneficiaryStatus" TEXT,
ADD COLUMN "holderName" TEXT,
ADD COLUMN "holderDocument" TEXT,
ADD COLUMN "dependentName" TEXT,
ADD COLUMN "dependentRelationship" TEXT;
