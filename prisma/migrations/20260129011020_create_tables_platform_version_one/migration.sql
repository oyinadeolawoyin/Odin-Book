/*
  Warnings:

  - You are about to drop the column `website` on the `User` table. All the data in the column will be lost.
  - You are about to drop the `Comment` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Favourite` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Follower` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Following` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Like` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Message` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Notification` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Post` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Reel` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_messageId_fkey";

-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_parentId_fkey";

-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_postId_fkey";

-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_reelId_fkey";

-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_userId_fkey";

-- DropForeignKey
ALTER TABLE "Favourite" DROP CONSTRAINT "Favourite_postId_fkey";

-- DropForeignKey
ALTER TABLE "Favourite" DROP CONSTRAINT "Favourite_userId_fkey";

-- DropForeignKey
ALTER TABLE "Follower" DROP CONSTRAINT "Follower_followerId_fkey";

-- DropForeignKey
ALTER TABLE "Follower" DROP CONSTRAINT "Follower_userId_fkey";

-- DropForeignKey
ALTER TABLE "Following" DROP CONSTRAINT "Following_followingId_fkey";

-- DropForeignKey
ALTER TABLE "Following" DROP CONSTRAINT "Following_userId_fkey";

-- DropForeignKey
ALTER TABLE "Like" DROP CONSTRAINT "Like_commentId_fkey";

-- DropForeignKey
ALTER TABLE "Like" DROP CONSTRAINT "Like_messageId_fkey";

-- DropForeignKey
ALTER TABLE "Like" DROP CONSTRAINT "Like_postId_fkey";

-- DropForeignKey
ALTER TABLE "Like" DROP CONSTRAINT "Like_reelId_fkey";

-- DropForeignKey
ALTER TABLE "Like" DROP CONSTRAINT "Like_userId_fkey";

-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_userId_fkey";

-- DropForeignKey
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_userId_fkey";

-- DropForeignKey
ALTER TABLE "Post" DROP CONSTRAINT "Post_userId_fkey";

-- DropForeignKey
ALTER TABLE "Reel" DROP CONSTRAINT "Reel_userId_fkey";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "website",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "avatar" DROP NOT NULL,
ALTER COLUMN "bio" DROP NOT NULL;

-- DropTable
DROP TABLE "Comment";

-- DropTable
DROP TABLE "Favourite";

-- DropTable
DROP TABLE "Follower";

-- DropTable
DROP TABLE "Following";

-- DropTable
DROP TABLE "Like";

-- DropTable
DROP TABLE "Message";

-- DropTable
DROP TABLE "Notification";

-- DropTable
DROP TABLE "Post";

-- DropTable
DROP TABLE "Reel";

-- CreateTable
CREATE TABLE "Project" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "link" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sprint" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "duration" INTEGER NOT NULL,
    "checkin" TEXT,
    "checkout" TEXT,
    "wordsWritten" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Sprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WritingPlan" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "mondayGoal" INTEGER,
    "tuesdayGoal" INTEGER,
    "wednesdayGoal" INTEGER,
    "thursdayGoal" INTEGER,
    "fridayGoal" INTEGER,
    "saturdayGoal" INTEGER,
    "sundayGoal" INTEGER,

    CONSTRAINT "WritingPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklyProgress" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "mondayDone" BOOLEAN NOT NULL DEFAULT false,
    "tuesdayDone" BOOLEAN NOT NULL DEFAULT false,
    "wednesdayDone" BOOLEAN NOT NULL DEFAULT false,
    "thursdayDone" BOOLEAN NOT NULL DEFAULT false,
    "fridayDone" BOOLEAN NOT NULL DEFAULT false,
    "saturdayDone" BOOLEAN NOT NULL DEFAULT false,
    "sundayDone" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "WeeklyProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Project_userId_idx" ON "Project"("userId");

-- CreateIndex
CREATE INDEX "Sprint_userId_idx" ON "Sprint"("userId");

-- CreateIndex
CREATE INDEX "Sprint_isActive_idx" ON "Sprint"("isActive");

-- CreateIndex
CREATE INDEX "Sprint_startedAt_idx" ON "Sprint"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WritingPlan_userId_key" ON "WritingPlan"("userId");

-- CreateIndex
CREATE INDEX "WritingPlan_userId_idx" ON "WritingPlan"("userId");

-- CreateIndex
CREATE INDEX "WeeklyProgress_userId_idx" ON "WeeklyProgress"("userId");

-- CreateIndex
CREATE INDEX "WeeklyProgress_weekStart_idx" ON "WeeklyProgress"("weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyProgress_userId_weekStart_key" ON "WeeklyProgress"("userId", "weekStart");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sprint" ADD CONSTRAINT "Sprint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WritingPlan" ADD CONSTRAINT "WritingPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyProgress" ADD CONSTRAINT "WeeklyProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
