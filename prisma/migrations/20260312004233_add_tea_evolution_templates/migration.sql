-- CreateTable
CREATE TABLE "tea_evolution_templates" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "procedureId" TEXT NOT NULL,
    "name" TEXT,
    "sessionGoal" TEXT,
    "interventionSummary" TEXT,
    "patientResponse" TEXT,
    "familyFeedback" TEXT,
    "homePlan" TEXT,
    "strategiesUsed" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tea_evolution_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tea_evolution_templates_branchId_procedureId_key" ON "tea_evolution_templates"("branchId", "procedureId");
CREATE INDEX "tea_evolution_templates_branchId_idx" ON "tea_evolution_templates"("branchId");
CREATE INDEX "tea_evolution_templates_procedureId_idx" ON "tea_evolution_templates"("procedureId");

-- AddForeignKey
ALTER TABLE "tea_evolution_templates"
ADD CONSTRAINT "tea_evolution_templates_procedureId_fkey"
FOREIGN KEY ("procedureId") REFERENCES "procedures"("id") ON DELETE CASCADE ON UPDATE CASCADE;
