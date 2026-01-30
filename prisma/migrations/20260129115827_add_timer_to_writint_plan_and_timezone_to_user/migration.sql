-- AlterTable
ALTER TABLE "User" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC';

-- AlterTable
ALTER TABLE "WritingPlan" ADD COLUMN     "fridayTime" TEXT,
ADD COLUMN     "mondayTime" TEXT,
ADD COLUMN     "saturdayTime" TEXT,
ADD COLUMN     "sundayTime" TEXT,
ADD COLUMN     "thursdayTime" TEXT,
ADD COLUMN     "tuesdayTime" TEXT,
ADD COLUMN     "wednesdayTime" TEXT;
