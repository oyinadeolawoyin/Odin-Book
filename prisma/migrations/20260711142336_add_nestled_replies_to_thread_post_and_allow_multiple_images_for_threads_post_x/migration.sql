-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "mediaUrls" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "ThreadReply" ADD COLUMN     "parentId" INTEGER;

-- CreateIndex
CREATE INDEX "ThreadReply_parentId_idx" ON "ThreadReply"("parentId");

-- AddForeignKey
ALTER TABLE "ThreadReply" ADD CONSTRAINT "ThreadReply_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ThreadReply"("id") ON DELETE CASCADE ON UPDATE CASCADE;
