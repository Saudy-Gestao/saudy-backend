-- CreateTable
CREATE TABLE "ai_questionnaires" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "patientComplaints" TEXT,
    "questions" JSONB NOT NULL,
    "answers" JSONB,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "savedAt" TIMESTAMP(3),

    CONSTRAINT "ai_questionnaires_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_questionnaires_appointmentId_key" ON "ai_questionnaires"("appointmentId");

-- AddForeignKey
ALTER TABLE "ai_questionnaires" ADD CONSTRAINT "ai_questionnaires_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
