-- Live threads: a post can be marked live (match days, events) and ended again. Additive only.

-- AlterTable
ALTER TABLE "Post" ADD COLUMN "live_started_at" TIMESTAMP(3),
ADD COLUMN "live_ended_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Post_live_started_at_idx" ON "Post"("live_started_at" DESC);
