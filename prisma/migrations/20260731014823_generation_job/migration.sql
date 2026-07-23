-- CreateTable
CREATE TABLE "GenerationJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "jd" TEXT,
    -- Quoted deliberately: Prisma emits `DEFAULT []` for a Json default, and
    -- SQLite reads bare square brackets as a quoted identifier rather than a
    -- JSON literal, so rows land with an empty string and the client then
    -- P2023s on read. See migrations/20260731013500_fix_tags_default.
    "tags" JSONB NOT NULL DEFAULT '[]',
    "type" TEXT NOT NULL DEFAULT 'debug',
    "difficulty" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "problemId" TEXT,
    "error" TEXT,
    "claimedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "GenerationJob_status_createdAt_idx" ON "GenerationJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationJob_sessionId_idx" ON "GenerationJob"("sessionId");
