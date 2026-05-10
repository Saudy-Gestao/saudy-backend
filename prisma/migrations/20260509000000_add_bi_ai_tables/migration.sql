-- CreateTable
CREATE TABLE IF NOT EXISTS "bi_insight_cache" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "positives" JSONB NOT NULL,
    "negatives" JSONB NOT NULL,
    "alerts" JSONB NOT NULL,
    "suggestions" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bi_insight_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "knowledge_suggestions" (
    "id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "codeContext" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "knowledge_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "code_chunks" (
    "id" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,

    CONSTRAINT "code_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "bi_insight_cache_companyId_cacheKey_key" ON "bi_insight_cache"("companyId", "cacheKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bi_insight_cache_companyId_cacheKey_idx" ON "bi_insight_cache"("companyId", "cacheKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bi_insight_cache_expiresAt_idx" ON "bi_insight_cache"("expiresAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "knowledge_suggestions_status_idx" ON "knowledge_suggestions"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "knowledge_suggestions_createdAt_idx" ON "knowledge_suggestions"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "code_chunks_repo_filePath_idx" ON "code_chunks"("repo", "filePath");
