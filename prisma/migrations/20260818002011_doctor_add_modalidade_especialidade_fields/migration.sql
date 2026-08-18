-- AlterTable
ALTER TABLE "doctors" ADD COLUMN     "appointmentDurations" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "branchIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "cbo" TEXT,
ADD COLUMN     "especialidadeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "metodos" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "modalidadeIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
