-- CreateTable
CREATE TABLE "tea_therapeutic_plans" (
    "id" TEXT NOT NULL,
    "teaProfileId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "objective" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'Média',
    "status" TEXT NOT NULL DEFAULT 'Ativo',
    "responsibleProfessional" TEXT,
    "targetDate" TIMESTAMP(3),
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tea_therapeutic_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tea_therapeutic_plans_teaProfileId_idx" ON "tea_therapeutic_plans"("teaProfileId");

-- AddForeignKey
ALTER TABLE "tea_therapeutic_plans" ADD CONSTRAINT "tea_therapeutic_plans_teaProfileId_fkey" FOREIGN KEY ("teaProfileId") REFERENCES "tea_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
