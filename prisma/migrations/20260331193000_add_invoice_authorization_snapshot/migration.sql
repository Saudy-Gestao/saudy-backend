ALTER TABLE "invoices"
ADD COLUMN "operatorGuideNumber" TEXT,
ADD COLUMN "authorizationPassword" TEXT,
ADD COLUMN "authorizationDate" TIMESTAMP(3),
ADD COLUMN "authorizationExpiryDate" TIMESTAMP(3),
ADD COLUMN "authorizedAttendanceType" TEXT;
