/*
  Warnings:

  - You are about to drop the column `is_pinned` on the `Comment` table. All the data in the column will be lost.
  - You are about to drop the column `pinned_at` on the `Comment` table. All the data in the column will be lost.
  - You are about to drop the column `pinned_by` on the `Comment` table. All the data in the column will be lost.
  - You are about to drop the column `pinned_reason` on the `Comment` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."Comment" DROP CONSTRAINT "Comment_pinned_by_fkey";

-- AlterTable
ALTER TABLE "public"."Comment" DROP COLUMN "is_pinned",
DROP COLUMN "pinned_at",
DROP COLUMN "pinned_by",
DROP COLUMN "pinned_reason";

-- AlterTable
ALTER TABLE "public"."CommunityJoinRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- AlterTable
ALTER TABLE "public"."FollowRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- AlterTable
ALTER TABLE "public"."Post" ADD COLUMN     "pinned_comment_at" TIMESTAMP(3),
ADD COLUMN     "pinned_comment_by" TEXT,
ADD COLUMN     "pinned_comment_id" TEXT,
ADD COLUMN     "pinned_comment_reason" TEXT;

-- AddForeignKey
ALTER TABLE "public"."Post" ADD CONSTRAINT "Post_pinned_comment_by_fkey" FOREIGN KEY ("pinned_comment_by") REFERENCES "public"."Moderator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Post" ADD CONSTRAINT "Post_pinned_comment_id_fkey" FOREIGN KEY ("pinned_comment_id") REFERENCES "public"."Comment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
