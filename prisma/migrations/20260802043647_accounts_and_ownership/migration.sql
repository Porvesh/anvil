-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" DATETIME
);

-- CreateTable
CREATE TABLE "LoginToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "userId" TEXT,
    "claimSessionId" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoginToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Attempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "problemId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT,
    "submission" JSONB NOT NULL,
    "runHistory" JSONB,
    "grade" JSONB,
    "transcript" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Attempt_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Attempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Attempt" ("createdAt", "grade", "id", "problemId", "runHistory", "sessionId", "submission", "transcript") SELECT "createdAt", "grade", "id", "problemId", "runHistory", "sessionId", "submission", "transcript" FROM "Attempt";
DROP TABLE "Attempt";
ALTER TABLE "new_Attempt" RENAME TO "Attempt";
CREATE INDEX "Attempt_sessionId_idx" ON "Attempt"("sessionId");
CREATE INDEX "Attempt_problemId_idx" ON "Attempt"("problemId");
CREATE INDEX "Attempt_userId_createdAt_idx" ON "Attempt"("userId", "createdAt");
CREATE INDEX "Attempt_sessionId_createdAt_idx" ON "Attempt"("sessionId", "createdAt");
CREATE TABLE "new_Contribution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT,
    "status" TEXT NOT NULL,
    "type" TEXT,
    "difficulty" TEXT,
    "seniority" TEXT,
    -- Quoted on purpose: Prisma emits a bare `DEFAULT []` for SQLite Json
    -- defaults, which SQLite parses as an identifier and stores as an empty
    -- string, breaking every later read with P2023. Same fix as
    -- 20260801212000_fix_contribution_tags_default, which this table rebuild
    -- would otherwise have silently undone.
    "tags" JSONB NOT NULL DEFAULT '[]',
    "qualityScore" REAL,
    "rejectionCode" TEXT,
    "problemId" TEXT,
    "duplicateProblemId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Contribution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Contribution" ("createdAt", "difficulty", "duplicateProblemId", "id", "model", "problemId", "provider", "qualityScore", "rejectionCode", "seniority", "sessionId", "status", "tags", "type", "updatedAt") SELECT "createdAt", "difficulty", "duplicateProblemId", "id", "model", "problemId", "provider", "qualityScore", "rejectionCode", "seniority", "sessionId", "status", "tags", "type", "updatedAt" FROM "Contribution";
DROP TABLE "Contribution";
ALTER TABLE "new_Contribution" RENAME TO "Contribution";
CREATE INDEX "Contribution_sessionId_createdAt_idx" ON "Contribution"("sessionId", "createdAt");
CREATE INDEX "Contribution_status_createdAt_idx" ON "Contribution"("status", "createdAt");
CREATE INDEX "Contribution_userId_createdAt_idx" ON "Contribution"("userId", "createdAt");
CREATE TABLE "new_Vote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "problemId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT,
    "value" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Vote_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Vote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Vote" ("createdAt", "id", "problemId", "sessionId", "updatedAt", "value") SELECT "createdAt", "id", "problemId", "sessionId", "updatedAt", "value" FROM "Vote";
DROP TABLE "Vote";
ALTER TABLE "new_Vote" RENAME TO "Vote";
CREATE INDEX "Vote_problemId_idx" ON "Vote"("problemId");
CREATE UNIQUE INDEX "Vote_problemId_sessionId_key" ON "Vote"("problemId", "sessionId");
CREATE UNIQUE INDEX "Vote_problemId_userId_key" ON "Vote"("problemId", "userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "LoginToken_tokenHash_key" ON "LoginToken"("tokenHash");

-- CreateIndex
CREATE INDEX "LoginToken_email_createdAt_idx" ON "LoginToken"("email", "createdAt");

-- CreateIndex
CREATE INDEX "LoginToken_expiresAt_idx" ON "LoginToken"("expiresAt");
