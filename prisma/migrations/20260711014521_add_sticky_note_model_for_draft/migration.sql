-- CreateEnum
CREATE TYPE "StickyNoteColor" AS ENUM ('YELLOW', 'PINK', 'BLUE', 'GREEN', 'PURPLE', 'ORANGE');

-- CreateTable
CREATE TABLE "StickyNote" (
    "id" SERIAL NOT NULL,
    "draftId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "paragraphIndex" INTEGER,
    "color" "StickyNoteColor" NOT NULL DEFAULT 'YELLOW',
    "text" TEXT NOT NULL DEFAULT '',
    "items" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StickyNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StickyNote_draftId_idx" ON "StickyNote"("draftId");

-- CreateIndex
CREATE INDEX "StickyNote_draftId_paragraphIndex_idx" ON "StickyNote"("draftId", "paragraphIndex");

-- AddForeignKey
ALTER TABLE "StickyNote" ADD CONSTRAINT "StickyNote_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "WritingDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
