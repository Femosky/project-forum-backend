-- Post insights: daily per-post totals and 90-day country/source breakdowns (aggregate counts only)

-- CreateEnum
CREATE TYPE "PostSourceKind" AS ENUM ('country', 'source');

-- CreateTable
CREATE TABLE "PostDailyStat" (
    "post_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "readers" INTEGER NOT NULL DEFAULT 0,
    "shares" INTEGER NOT NULL DEFAULT 0,

CONSTRAINT "PostDailyStat_pkey" PRIMARY KEY ("post_id","date")
);

-- CreateTable
CREATE TABLE "PostDailySource" (
    "post_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "kind" "PostSourceKind" NOT NULL,
    "key" TEXT NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,

CONSTRAINT "PostDailySource_pkey" PRIMARY KEY ("post_id","date","kind","key")
);

-- CreateIndex
CREATE INDEX "PostDailyStat_date_idx" ON "PostDailyStat"("date");

-- CreateIndex
CREATE INDEX "PostDailySource_date_idx" ON "PostDailySource"("date");

-- AddForeignKey
ALTER TABLE "PostDailyStat" ADD CONSTRAINT "PostDailyStat_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostDailySource" ADD CONSTRAINT "PostDailySource_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
