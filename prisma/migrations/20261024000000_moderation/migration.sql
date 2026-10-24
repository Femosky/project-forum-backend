-- CreateEnum
CREATE TYPE "BlockedTermKind" AS ENUM ('domain', 'keyword');

-- Phase 5: moderation and anti-abuse (report reasons, mutes, blocklist, filter holds, suspensions, shadow-bans)

-- AlterEnum
ALTER TYPE "ReportReason" ADD VALUE 'scam';
ALTER TYPE "ReportReason" ADD VALUE 'personal_info';

-- AlterTable: directory categories (Phase 3 leftover)
ALTER TABLE "Community" ADD COLUMN "category" TEXT;
CREATE INDEX "Community_category_member_count_idx" ON "Community"("category", "member_count" DESC);

-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "held_reason" TEXT,
ADD COLUMN     "shadow_hidden" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "held_reason" TEXT,
ADD COLUMN     "shadow_hidden" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "shadow_banned_at" TIMESTAMP(3),
ADD COLUMN     "suspended_until" TIMESTAMP(3),
ADD COLUMN     "suspension_reason" TEXT;

-- CreateTable
CREATE TABLE "CommunityMute" (
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "community_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "muted_until" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "muted_by" UUID NOT NULL,

    CONSTRAINT "CommunityMute_pkey" PRIMARY KEY ("community_id","user_id")
);

-- CreateTable
CREATE TABLE "BlockedTerm" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" "BlockedTermKind" NOT NULL,
    "value" TEXT NOT NULL,
    "note" TEXT,
    "created_by" UUID NOT NULL,

    CONSTRAINT "BlockedTerm_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommunityMute_user_id_idx" ON "CommunityMute"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "BlockedTerm_kind_value_key" ON "BlockedTerm"("kind", "value");

-- CreateIndex
CREATE INDEX "Comment_status_post_id_idx" ON "Comment"("status", "post_id");

-- CreateIndex
CREATE INDEX "ModAction_created_at_idx" ON "ModAction"("created_at" DESC);

-- CreateIndex
CREATE INDEX "Post_community_id_status_idx" ON "Post"("community_id", "status");

-- AddForeignKey
ALTER TABLE "CommunityMute" ADD CONSTRAINT "CommunityMute_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityMute" ADD CONSTRAINT "CommunityMute_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityMute" ADD CONSTRAINT "CommunityMute_muted_by_fkey" FOREIGN KEY ("muted_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockedTerm" ADD CONSTRAINT "BlockedTerm_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

