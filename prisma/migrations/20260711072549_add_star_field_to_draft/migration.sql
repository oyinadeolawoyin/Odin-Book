-- AlterTable
ALTER TABLE "WritingDraft" ADD COLUMN     "isStarred" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "WritingDraft_userId_isStarred_idx" ON "WritingDraft"("userId", "isStarred");
