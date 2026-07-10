-- CreateTable
CREATE TABLE "Vote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "problemId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Vote_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Problem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'python',
    "difficulty" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "jdContext" TEXT,
    "starterCode" TEXT,
    "diff" JSONB,
    "prMeta" JSONB,
    "testSuite" JSONB,
    "rubric" JSONB,
    "answerKey" JSONB NOT NULL,
    "qualityScore" REAL,
    "source" TEXT NOT NULL DEFAULT 'authored',
    "upvotes" INTEGER NOT NULL DEFAULT 0,
    "downvotes" INTEGER NOT NULL DEFAULT 0,
    "timesAttempted" INTEGER NOT NULL DEFAULT 0,
    "retired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Problem" ("answerKey", "createdAt", "diff", "difficulty", "id", "jdContext", "language", "prMeta", "prompt", "qualityScore", "rubric", "source", "starterCode", "testSuite", "title", "type") SELECT "answerKey", "createdAt", "diff", "difficulty", "id", "jdContext", "language", "prMeta", "prompt", "qualityScore", "rubric", "source", "starterCode", "testSuite", "title", "type" FROM "Problem";
DROP TABLE "Problem";
ALTER TABLE "new_Problem" RENAME TO "Problem";
CREATE INDEX "Problem_retired_type_difficulty_idx" ON "Problem"("retired", "type", "difficulty");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Vote_problemId_idx" ON "Vote"("problemId");

-- CreateIndex
CREATE UNIQUE INDEX "Vote_problemId_sessionId_key" ON "Vote"("problemId", "sessionId");
