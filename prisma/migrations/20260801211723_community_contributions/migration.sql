-- AlterTable
ALTER TABLE "Problem" ADD COLUMN "intakeQualityScore" REAL;
ALTER TABLE "Problem" ADD COLUMN "sanitizationVersion" TEXT;
ALTER TABLE "Problem" ADD COLUMN "sourceContributionId" TEXT;

-- CreateTable
CREATE TABLE "Contribution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "type" TEXT,
    "difficulty" TEXT,
    "seniority" TEXT,
    "tags" JSONB NOT NULL DEFAULT [],
    "qualityScore" REAL,
    "rejectionCode" TEXT,
    "problemId" TEXT,
    "duplicateProblemId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Contribution_sessionId_createdAt_idx" ON "Contribution"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "Contribution_status_createdAt_idx" ON "Contribution"("status", "createdAt");
