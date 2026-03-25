ALTER TABLE "pre_scheduling_flows"
ADD COLUMN "anamnesisSentAt" TIMESTAMP(3),
ADD COLUMN "anamnesisSentByUserId" TEXT;

CREATE TABLE "pre_scheduling_anamnesis_responses" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "templateId" TEXT,
    "templateName" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pre_scheduling_anamnesis_responses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pre_scheduling_anamnesis_answers" (
    "id" TEXT NOT NULL,
    "responseId" TEXT NOT NULL,
    "questionId" TEXT,
    "questionLabel" TEXT NOT NULL,
    "responseType" TEXT NOT NULL,
    "answerText" TEXT,
    "answerValues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "answerBoolean" BOOLEAN,
    "answerNumber" DOUBLE PRECISION,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pre_scheduling_anamnesis_answers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pre_scheduling_anamnesis_responses_flowId_key" ON "pre_scheduling_anamnesis_responses"("flowId");
CREATE INDEX "pre_scheduling_anamnesis_responses_flowId_idx" ON "pre_scheduling_anamnesis_responses"("flowId");
CREATE INDEX "pre_scheduling_anamnesis_answers_responseId_idx" ON "pre_scheduling_anamnesis_answers"("responseId");

ALTER TABLE "pre_scheduling_anamnesis_responses"
ADD CONSTRAINT "pre_scheduling_anamnesis_responses_flowId_fkey"
FOREIGN KEY ("flowId") REFERENCES "pre_scheduling_flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pre_scheduling_anamnesis_answers"
ADD CONSTRAINT "pre_scheduling_anamnesis_answers_responseId_fkey"
FOREIGN KEY ("responseId") REFERENCES "pre_scheduling_anamnesis_responses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
