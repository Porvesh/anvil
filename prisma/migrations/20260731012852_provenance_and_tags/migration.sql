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
    "files" JSONB,
    "diff" JSONB,
    "prMeta" JSONB,
    "testSuite" JSONB,
    "rubric" JSONB,
    "answerKey" JSONB NOT NULL,
    "qualityScore" REAL,
    "source" TEXT NOT NULL DEFAULT 'authored',
    "generatorModel" TEXT,
    "sourceJobId" TEXT,
    "tags" JSONB NOT NULL DEFAULT [],
    "upvotes" INTEGER NOT NULL DEFAULT 0,
    "downvotes" INTEGER NOT NULL DEFAULT 0,
    "timesAttempted" INTEGER NOT NULL DEFAULT 0,
    "retired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Problem" ("answerKey", "createdAt", "diff", "difficulty", "downvotes", "files", "id", "jdContext", "language", "prMeta", "prompt", "qualityScore", "retired", "rubric", "source", "starterCode", "testSuite", "timesAttempted", "title", "type", "upvotes") SELECT "answerKey", "createdAt", "diff", "difficulty", "downvotes", "files", "id", "jdContext", "language", "prMeta", "prompt", "qualityScore", "retired", "rubric", "source", "starterCode", "testSuite", "timesAttempted", "title", "type", "upvotes" FROM "Problem";
DROP TABLE "Problem";
ALTER TABLE "new_Problem" RENAME TO "Problem";
CREATE INDEX "Problem_retired_type_difficulty_idx" ON "Problem"("retired", "type", "difficulty");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
