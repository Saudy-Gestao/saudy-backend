ALTER TABLE "consultations"
ADD COLUMN IF NOT EXISTS "triageCompletedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "procedure_nursing_templates" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "procedureId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "collectHeight" BOOLEAN NOT NULL DEFAULT false,
    "collectWeight" BOOLEAN NOT NULL DEFAULT false,
    "collectBloodPressure" BOOLEAN NOT NULL DEFAULT false,
    "collectTemperature" BOOLEAN NOT NULL DEFAULT false,
    "collectHeartRate" BOOLEAN NOT NULL DEFAULT false,
    "collectOxygenSaturation" BOOLEAN NOT NULL DEFAULT false,
    "collectGlucose" BOOLEAN NOT NULL DEFAULT false,
    "collectPregnancyCheck" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "procedure_nursing_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "procedure_nursing_questions" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "helpText" TEXT,
    "responseType" TEXT NOT NULL,
    "placeholder" TEXT,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "procedure_nursing_questions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "procedure_nursing_question_options" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "procedure_nursing_question_options_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "consultation_nursing_responses" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "templateId" TEXT,
    "templateName" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consultation_nursing_responses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "consultation_nursing_answers" (
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
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consultation_nursing_answers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "procedure_nursing_templates_branchId_procedureId_key"
ON "procedure_nursing_templates"("branchId", "procedureId");

CREATE INDEX IF NOT EXISTS "procedure_nursing_templates_branchId_idx"
ON "procedure_nursing_templates"("branchId");

CREATE INDEX IF NOT EXISTS "procedure_nursing_templates_procedureId_idx"
ON "procedure_nursing_templates"("procedureId");

CREATE INDEX IF NOT EXISTS "procedure_nursing_questions_templateId_idx"
ON "procedure_nursing_questions"("templateId");

CREATE INDEX IF NOT EXISTS "procedure_nursing_question_options_questionId_idx"
ON "procedure_nursing_question_options"("questionId");

CREATE UNIQUE INDEX IF NOT EXISTS "consultation_nursing_responses_consultationId_key"
ON "consultation_nursing_responses"("consultationId");

CREATE INDEX IF NOT EXISTS "consultation_nursing_responses_consultationId_idx"
ON "consultation_nursing_responses"("consultationId");

CREATE INDEX IF NOT EXISTS "consultation_nursing_answers_responseId_idx"
ON "consultation_nursing_answers"("responseId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'procedure_nursing_templates_procedureId_fkey'
  ) THEN
    ALTER TABLE "procedure_nursing_templates"
    ADD CONSTRAINT "procedure_nursing_templates_procedureId_fkey"
    FOREIGN KEY ("procedureId") REFERENCES "procedures"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'procedure_nursing_questions_templateId_fkey'
  ) THEN
    ALTER TABLE "procedure_nursing_questions"
    ADD CONSTRAINT "procedure_nursing_questions_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "procedure_nursing_templates"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'procedure_nursing_question_options_questionId_fkey'
  ) THEN
    ALTER TABLE "procedure_nursing_question_options"
    ADD CONSTRAINT "procedure_nursing_question_options_questionId_fkey"
    FOREIGN KEY ("questionId") REFERENCES "procedure_nursing_questions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'consultation_nursing_responses_consultationId_fkey'
  ) THEN
    ALTER TABLE "consultation_nursing_responses"
    ADD CONSTRAINT "consultation_nursing_responses_consultationId_fkey"
    FOREIGN KEY ("consultationId") REFERENCES "consultations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'consultation_nursing_answers_responseId_fkey'
  ) THEN
    ALTER TABLE "consultation_nursing_answers"
    ADD CONSTRAINT "consultation_nursing_answers_responseId_fkey"
    FOREIGN KEY ("responseId") REFERENCES "consultation_nursing_responses"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
