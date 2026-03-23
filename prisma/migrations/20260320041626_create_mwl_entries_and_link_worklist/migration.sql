-- AlterTable
ALTER TABLE "report_worklist_items" ADD COLUMN     "mwlEntryId" TEXT;

-- CreateTable
CREATE TABLE "mwl_entries" (
    "id" TEXT NOT NULL,
    "branchId" TEXT,
    "appointmentId" TEXT,
    "accessionNumber" TEXT,
    "patientName" TEXT,
    "patientCpf" TEXT,
    "examType" TEXT,
    "scheduledAt" TEXT,
    "convenio" TEXT,
    "requestingDoctor" TEXT,
    "status" TEXT NOT NULL DEFAULT 'agendado',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "mwl_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mwl_entries_branchId_idx" ON "mwl_entries"("branchId");

-- CreateIndex
CREATE INDEX "mwl_entries_appointmentId_idx" ON "mwl_entries"("appointmentId");

-- CreateIndex
CREATE INDEX "mwl_entries_accessionNumber_idx" ON "mwl_entries"("accessionNumber");

-- CreateIndex
CREATE INDEX "mwl_entries_patientCpf_idx" ON "mwl_entries"("patientCpf");

-- CreateIndex
CREATE INDEX "mwl_entries_status_idx" ON "mwl_entries"("status");

-- AddForeignKey
ALTER TABLE "mwl_entries" ADD CONSTRAINT "mwl_entries_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_worklist_items" ADD CONSTRAINT "report_worklist_items_mwlEntryId_fkey" FOREIGN KEY ("mwlEntryId") REFERENCES "mwl_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
