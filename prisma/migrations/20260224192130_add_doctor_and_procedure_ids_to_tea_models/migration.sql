-- AlterTable
ALTER TABLE "tea_evolutions" ADD COLUMN     "professionalDoctorId" TEXT;

-- AlterTable
ALTER TABLE "tea_pit_therapies" ADD COLUMN     "procedureId" TEXT,
ADD COLUMN     "professionalDoctorId" TEXT;

-- AlterTable
ALTER TABLE "tea_therapeutic_plans" ADD COLUMN     "responsibleDoctorId" TEXT;
