CREATE TABLE "procedure_anamnesis_templates" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "procedureId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "procedure_anamnesis_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "procedure_anamnesis_questions" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "helpText" TEXT,
    "responseType" TEXT NOT NULL,
    "placeholder" TEXT,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "procedure_anamnesis_questions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "procedure_anamnesis_question_options" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "procedure_anamnesis_question_options_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "procedure_anamnesis_templates_branchId_procedureId_key" ON "procedure_anamnesis_templates"("branchId", "procedureId");
CREATE INDEX "procedure_anamnesis_templates_branchId_idx" ON "procedure_anamnesis_templates"("branchId");
CREATE INDEX "procedure_anamnesis_templates_procedureId_idx" ON "procedure_anamnesis_templates"("procedureId");
CREATE INDEX "procedure_anamnesis_questions_templateId_idx" ON "procedure_anamnesis_questions"("templateId");
CREATE INDEX "procedure_anamnesis_question_options_questionId_idx" ON "procedure_anamnesis_question_options"("questionId");

ALTER TABLE "procedure_anamnesis_templates"
ADD CONSTRAINT "procedure_anamnesis_templates_procedureId_fkey"
FOREIGN KEY ("procedureId") REFERENCES "procedures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "procedure_anamnesis_questions"
ADD CONSTRAINT "procedure_anamnesis_questions_templateId_fkey"
FOREIGN KEY ("templateId") REFERENCES "procedure_anamnesis_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "procedure_anamnesis_question_options"
ADD CONSTRAINT "procedure_anamnesis_question_options_questionId_fkey"
FOREIGN KEY ("questionId") REFERENCES "procedure_anamnesis_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
