-- Prisma emits bare DEFAULT [] for SQLite Json defaults. SQLite reads that as
-- an empty identifier rather than the JSON array literal, so recreate the new
-- metadata-only table with the correctly quoted default.
UPDATE "Contribution" SET "tags" = '[]' WHERE "tags" IS NULL OR "tags" = '' OR json_valid("tags") = 0;

CREATE TABLE "new_Contribution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "type" TEXT,
    "difficulty" TEXT,
    "seniority" TEXT,
    "tags" JSONB NOT NULL DEFAULT '[]',
    "qualityScore" REAL,
    "rejectionCode" TEXT,
    "problemId" TEXT,
    "duplicateProblemId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Contribution" SELECT "id", "sessionId", "status", "type", "difficulty", "seniority", "tags", "qualityScore", "rejectionCode", "problemId", "duplicateProblemId", "provider", "model", "createdAt", "updatedAt" FROM "Contribution";
DROP TABLE "Contribution";
ALTER TABLE "new_Contribution" RENAME TO "Contribution";
CREATE INDEX "Contribution_sessionId_createdAt_idx" ON "Contribution"("sessionId", "createdAt");
CREATE INDEX "Contribution_status_createdAt_idx" ON "Contribution"("status", "createdAt");
