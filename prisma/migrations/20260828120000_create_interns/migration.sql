CREATE TABLE "interns" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cpf" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "institution" TEXT,
    "course" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "interns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "intern_doctors" (
    "id" TEXT NOT NULL,
    "internId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    CONSTRAINT "intern_doctors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "intern_doctors_internId_doctorId_key" ON "intern_doctors"("internId", "doctorId");
CREATE INDEX "interns_branchId_isActive_idx" ON "interns"("branchId", "isActive");
CREATE INDEX "interns_name_idx" ON "interns"("name");
CREATE INDEX "intern_doctors_doctorId_idx" ON "intern_doctors"("doctorId");
ALTER TABLE "interns" ADD CONSTRAINT "interns_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "intern_doctors" ADD CONSTRAINT "intern_doctors_internId_fkey" FOREIGN KEY ("internId") REFERENCES "interns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "intern_doctors" ADD CONSTRAINT "intern_doctors_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
