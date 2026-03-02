-- CreateTable
CREATE TABLE "tea_evolutions" (
    "id" TEXT NOT NULL,
    "teaProfileId" TEXT NOT NULL,
    "therapeuticPlanId" TEXT,
    "sessionDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "professional" TEXT,
    "interventionSummary" TEXT,
    "patientResponse" TEXT,
    "progressScore" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tea_evolutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tea_pits" (
    "id" TEXT NOT NULL,
    "teaProfileId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startDate" TIMESTAMP(3),
    "reviewDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'Ativo',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tea_pits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tea_pit_therapies" (
    "id" TEXT NOT NULL,
    "pitId" TEXT NOT NULL,
    "therapyType" TEXT NOT NULL,
    "weeklyFrequency" INTEGER NOT NULL DEFAULT 1,
    "durationMinutes" INTEGER,
    "professional" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tea_pit_therapies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tea_evolutions_teaProfileId_idx" ON "tea_evolutions"("teaProfileId");

-- CreateIndex
CREATE INDEX "tea_evolutions_therapeuticPlanId_idx" ON "tea_evolutions"("therapeuticPlanId");

-- CreateIndex
CREATE UNIQUE INDEX "tea_pits_teaProfileId_key" ON "tea_pits"("teaProfileId");

-- CreateIndex
CREATE INDEX "tea_pit_therapies_pitId_idx" ON "tea_pit_therapies"("pitId");

-- AddForeignKey
ALTER TABLE "tea_evolutions" ADD CONSTRAINT "tea_evolutions_teaProfileId_fkey" FOREIGN KEY ("teaProfileId") REFERENCES "tea_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tea_evolutions" ADD CONSTRAINT "tea_evolutions_therapeuticPlanId_fkey" FOREIGN KEY ("therapeuticPlanId") REFERENCES "tea_therapeutic_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tea_pits" ADD CONSTRAINT "tea_pits_teaProfileId_fkey" FOREIGN KEY ("teaProfileId") REFERENCES "tea_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tea_pit_therapies" ADD CONSTRAINT "tea_pit_therapies_pitId_fkey" FOREIGN KEY ("pitId") REFERENCES "tea_pits"("id") ON DELETE CASCADE ON UPDATE CASCADE;
