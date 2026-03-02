-- AlterTable
ALTER TABLE "tea_pit_therapies" ADD COLUMN     "preferredWeekdays" TEXT[] DEFAULT ARRAY[]::TEXT[];
