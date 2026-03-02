-- CreateTable
CREATE TABLE "tea_profiles" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "supportLevel" TEXT,
    "communicationProfile" TEXT,
    "sensoryProfile" TEXT,
    "behaviorNotes" TEXT,
    "comorbidities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "therapeuticGoals" TEXT,
    "familyGuidance" TEXT,
    "schoolNotes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tea_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tea_profiles_patientId_key" ON "tea_profiles"("patientId");

-- AddForeignKey
ALTER TABLE "tea_profiles" ADD CONSTRAINT "tea_profiles_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
