-- CreateTable
CREATE TABLE "MiniChallengeWeekAssignment" (
    "id" SERIAL NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "templateId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MiniChallengeWeekAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MiniChallengeWeekAssignment_weekStart_key" ON "MiniChallengeWeekAssignment"("weekStart");

-- CreateIndex
CREATE INDEX "MiniChallengeWeekAssignment_templateId_idx" ON "MiniChallengeWeekAssignment"("templateId");

-- AddForeignKey
ALTER TABLE "MiniChallengeWeekAssignment" ADD CONSTRAINT "MiniChallengeWeekAssignment_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MiniChallengeTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
