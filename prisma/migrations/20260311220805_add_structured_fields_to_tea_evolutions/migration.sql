-- AlterTable
ALTER TABLE "tea_evolutions"
ADD COLUMN     "alerts" TEXT,
ADD COLUMN     "behaviorLevel" TEXT,
ADD COLUMN     "engagementLevel" TEXT,
ADD COLUMN     "familyFeedback" TEXT,
ADD COLUMN     "homePlan" TEXT,
ADD COLUMN     "regulationLevel" TEXT,
ADD COLUMN     "sessionGoal" TEXT,
ADD COLUMN     "strategiesUsed" TEXT[] DEFAULT ARRAY[]::TEXT[];
