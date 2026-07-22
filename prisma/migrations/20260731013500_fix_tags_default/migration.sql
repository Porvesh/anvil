-- Repair the `tags` default and backfill rows created under the broken one.
--
-- Prisma emitted `"tags" JSONB NOT NULL DEFAULT []` for the Json column default.
-- SQLite treats square brackets as identifier quoting (an MS-Access
-- compatibility quirk), so `[]` was read as a zero-length identifier and every
-- pre-existing row was backfilled with an empty string instead of an empty JSON
-- array. Prisma's client then fails the whole query with P2023 ("EOF while
-- parsing a value") the moment it reads one of those rows — which takes down
-- any query that merely *includes* a Problem, not just ones selecting tags.

UPDATE "Problem" SET "tags" = '[]' WHERE "tags" IS NULL OR "tags" = '' OR json_valid("tags") = 0;

-- Redefine the table so the stored default is a real JSON literal.
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
    "tags" JSONB NOT NULL DEFAULT '[]',
    "upvotes" INTEGER NOT NULL DEFAULT 0,
    "downvotes" INTEGER NOT NULL DEFAULT 0,
    "timesAttempted" INTEGER NOT NULL DEFAULT 0,
    "retired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Problem" SELECT "id", "type", "language", "difficulty", "title", "prompt", "jdContext", "starterCode", "files", "diff", "prMeta", "testSuite", "rubric", "answerKey", "qualityScore", "source", "generatorModel", "sourceJobId", "tags", "upvotes", "downvotes", "timesAttempted", "retired", "createdAt" FROM "Problem";
DROP TABLE "Problem";
ALTER TABLE "new_Problem" RENAME TO "Problem";
CREATE INDEX "Problem_retired_type_difficulty_idx" ON "Problem"("retired", "type", "difficulty");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
