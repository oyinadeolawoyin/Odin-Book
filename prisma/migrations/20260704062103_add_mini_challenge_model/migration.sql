/*
  Warnings:

  - You are about to drop the column `finisherRole` on the `Event` table. All the data in the column will be lost.
  - The `role` column on the `User` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Added the required column `badgeIcon` to the `Event` table without a default value. This is not possible if the table is not empty.
  - Added the required column `badgeName` to the `Event` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "MiniChallengeType" AS ENUM ('SESSION_COUNT', 'WEEKLY_GOAL', 'SPRINT_COUNT', 'CONSECUTIVE_DAYS');

-- CreateEnum
CREATE TYPE "BadgeSourceType" AS ENUM ('EVENT', 'MINI_CHALLENGE', 'MILESTONE');

-- AlterTable
ALTER TABLE "Event" DROP COLUMN "finisherRole",
ADD COLUMN     "badgeIcon" TEXT NOT NULL,
ADD COLUMN     "badgeName" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "role",
ADD COLUMN     "role" "Role" NOT NULL DEFAULT 'USER';

-- CreateTable
CREATE TABLE "MiniChallengeTemplate" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "MiniChallengeType" NOT NULL,
    "targetValue" INTEGER NOT NULL,
    "badgeName" TEXT NOT NULL,
    "badgeIcon" TEXT NOT NULL,
    "rotationOrder" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MiniChallengeTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MiniChallengeResult" (
    "id" SERIAL NOT NULL,
    "templateId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "achievedValue" INTEGER NOT NULL,
    "targetValue" INTEGER,
    "completed" BOOLEAN NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MiniChallengeResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBadge" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "sourceType" "BadgeSourceType" NOT NULL,
    "sourceId" INTEGER NOT NULL,
    "weekStart" TIMESTAMP(3),
    "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),

    CONSTRAINT "UserBadge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MiniChallengeTemplate_rotationOrder_key" ON "MiniChallengeTemplate"("rotationOrder");

-- CreateIndex
CREATE INDEX "MiniChallengeTemplate_rotationOrder_idx" ON "MiniChallengeTemplate"("rotationOrder");

-- CreateIndex
CREATE INDEX "MiniChallengeTemplate_isActive_idx" ON "MiniChallengeTemplate"("isActive");

-- CreateIndex
CREATE INDEX "MiniChallengeResult_templateId_idx" ON "MiniChallengeResult"("templateId");

-- CreateIndex
CREATE INDEX "MiniChallengeResult_userId_idx" ON "MiniChallengeResult"("userId");

-- CreateIndex
CREATE INDEX "MiniChallengeResult_weekStart_idx" ON "MiniChallengeResult"("weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "MiniChallengeResult_weekStart_userId_key" ON "MiniChallengeResult"("weekStart", "userId");

-- CreateIndex
CREATE INDEX "UserBadge_userId_idx" ON "UserBadge"("userId");

-- CreateIndex
CREATE INDEX "UserBadge_claimedAt_idx" ON "UserBadge"("claimedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserBadge_userId_sourceType_sourceId_weekStart_key" ON "UserBadge"("userId", "sourceType", "sourceId", "weekStart");

-- AddForeignKey
ALTER TABLE "MiniChallengeResult" ADD CONSTRAINT "MiniChallengeResult_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MiniChallengeTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MiniChallengeResult" ADD CONSTRAINT "MiniChallengeResult_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBadge" ADD CONSTRAINT "UserBadge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
