-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "isDeprioritized" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Thread_isDeprioritized_idx" ON "Thread"("isDeprioritized");
