-- CreateTable
CREATE TABLE "report_configs" (
    "id" TEXT NOT NULL,
    "requiresReviewer" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_configs_pkey" PRIMARY KEY ("id")
);
