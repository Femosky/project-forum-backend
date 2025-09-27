/*
  Warnings:

  - You are about to drop the column `is_pinned` on the `Post` table. All the data in the column will be lost.
  - You are about to drop the column `pinned_at` on the `Post` table. All the data in the column will be lost.
  - You are about to drop the column `pinned_by` on the `Post` table. All the data in the column will be lost.
  - You are about to drop the column `pinned_reason` on the `Post` table. All the data in the column will be lost.

*/
-- AlterEnum
ALTER TYPE "public"."CommentStatus" ADD VALUE 'removed';

-- DropForeignKey
ALTER TABLE "public"."Post" DROP CONSTRAINT "Post_pinned_by_fkey";

-- AlterTable
ALTER TABLE "public"."Community" ADD COLUMN     "pinned_post_at" TIMESTAMP(3),
ADD COLUMN     "pinned_post_by" TEXT,
ADD COLUMN     "pinned_post_id" TEXT,
ADD COLUMN     "pinned_post_reason" TEXT;

-- AlterTable
ALTER TABLE "public"."CommunityJoinRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- AlterTable
ALTER TABLE "public"."FollowRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- AlterTable
ALTER TABLE "public"."Post" DROP COLUMN "is_pinned",
DROP COLUMN "pinned_at",
DROP COLUMN "pinned_by",
DROP COLUMN "pinned_reason";

-- AddForeignKey
ALTER TABLE "public"."Community" ADD CONSTRAINT "Community_pinned_post_by_fkey" FOREIGN KEY ("pinned_post_by") REFERENCES "public"."Moderator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Community" ADD CONSTRAINT "Community_pinned_post_id_fkey" FOREIGN KEY ("pinned_post_id") REFERENCES "public"."Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;
