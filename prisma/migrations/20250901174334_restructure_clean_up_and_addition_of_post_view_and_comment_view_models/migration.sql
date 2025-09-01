-- AlterEnum
ALTER TYPE "public"."ModeratorRole" ADD VALUE 'creator';

-- DropForeignKey
ALTER TABLE "public"."Moderator" DROP CONSTRAINT "Moderator_added_by_fkey";

-- AlterTable
ALTER TABLE "public"."Comment" ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "deleted_reason" TEXT,
ADD COLUMN     "edited_at" TIMESTAMP(3),
ADD COLUMN     "hidden_at" TIMESTAMP(3),
ADD COLUMN     "hidden_by" TEXT,
ADD COLUMN     "hidden_reason" TEXT,
ADD COLUMN     "impressions" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "is_deleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_edited" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_hidden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_pinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_removed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pinned_at" TIMESTAMP(3),
ADD COLUMN     "pinned_by" TEXT,
ADD COLUMN     "pinned_reason" TEXT,
ADD COLUMN     "removed_at" TIMESTAMP(3),
ADD COLUMN     "removed_by" TEXT,
ADD COLUMN     "removed_reason" TEXT,
ADD COLUMN     "sponsored_at" TIMESTAMP(3),
ADD COLUMN     "sponsored_by" TEXT,
ADD COLUMN     "sponsored_reason" TEXT;

-- AlterTable
ALTER TABLE "public"."CommunityJoinRequest" ADD COLUMN     "is_accepted" BOOLEAN,
ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- AlterTable
ALTER TABLE "public"."FollowRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- AlterTable
ALTER TABLE "public"."Moderator" ADD COLUMN     "added_by_date" TIMESTAMP(3),
ADD COLUMN     "is_removed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "removed_at" TIMESTAMP(3),
ADD COLUMN     "removed_by" TEXT,
ADD COLUMN     "removed_reason" TEXT;

-- AlterTable
ALTER TABLE "public"."Post" ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "deleted_reason" TEXT,
ADD COLUMN     "edited_at" TIMESTAMP(3),
ADD COLUMN     "hidden_at" TIMESTAMP(3),
ADD COLUMN     "hidden_by" TEXT,
ADD COLUMN     "hidden_reason" TEXT,
ADD COLUMN     "is_deleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_edited" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_hidden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_pinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pinned_at" TIMESTAMP(3),
ADD COLUMN     "pinned_by" TEXT,
ADD COLUMN     "pinned_reason" TEXT,
ADD COLUMN     "removed_by" TEXT,
ADD COLUMN     "sponsored_at" TIMESTAMP(3),
ADD COLUMN     "sponsored_by" TEXT,
ADD COLUMN     "sponsored_reason" TEXT;

-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "display_name" TEXT;

-- CreateTable
CREATE TABLE "public"."PostView" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "post_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "PostView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CommentView" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "comment_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "CommentView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."_saved_comments" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_saved_comments_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "PostView_post_id_idx" ON "public"."PostView"("post_id");

-- CreateIndex
CREATE INDEX "PostView_user_id_idx" ON "public"."PostView"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "PostView_post_id_user_id_key" ON "public"."PostView"("post_id", "user_id");

-- CreateIndex
CREATE INDEX "CommentView_comment_id_idx" ON "public"."CommentView"("comment_id");

-- CreateIndex
CREATE INDEX "CommentView_user_id_idx" ON "public"."CommentView"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "CommentView_comment_id_user_id_key" ON "public"."CommentView"("comment_id", "user_id");

-- CreateIndex
CREATE INDEX "_saved_comments_B_index" ON "public"."_saved_comments"("B");

-- CreateIndex
CREATE INDEX "Moderator_is_removed_idx" ON "public"."Moderator"("is_removed");

-- AddForeignKey
ALTER TABLE "public"."CommunityJoinRequest" ADD CONSTRAINT "CommunityJoinRequest_response_by_fkey" FOREIGN KEY ("response_by") REFERENCES "public"."Moderator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Moderator" ADD CONSTRAINT "Moderator_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "public"."Moderator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Moderator" ADD CONSTRAINT "Moderator_removed_by_fkey" FOREIGN KEY ("removed_by") REFERENCES "public"."Moderator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PostView" ADD CONSTRAINT "PostView_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."Post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PostView" ADD CONSTRAINT "PostView_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Post" ADD CONSTRAINT "Post_sponsored_by_fkey" FOREIGN KEY ("sponsored_by") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Post" ADD CONSTRAINT "Post_pinned_by_fkey" FOREIGN KEY ("pinned_by") REFERENCES "public"."Moderator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Post" ADD CONSTRAINT "Post_hidden_by_fkey" FOREIGN KEY ("hidden_by") REFERENCES "public"."Moderator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Post" ADD CONSTRAINT "Post_removed_by_fkey" FOREIGN KEY ("removed_by") REFERENCES "public"."Moderator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CommentView" ADD CONSTRAINT "CommentView_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "public"."Comment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CommentView" ADD CONSTRAINT "CommentView_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Comment" ADD CONSTRAINT "Comment_pinned_by_fkey" FOREIGN KEY ("pinned_by") REFERENCES "public"."Moderator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Comment" ADD CONSTRAINT "Comment_hidden_by_fkey" FOREIGN KEY ("hidden_by") REFERENCES "public"."Moderator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Comment" ADD CONSTRAINT "Comment_removed_by_fkey" FOREIGN KEY ("removed_by") REFERENCES "public"."Moderator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Comment" ADD CONSTRAINT "Comment_sponsored_by_fkey" FOREIGN KEY ("sponsored_by") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_saved_comments" ADD CONSTRAINT "_saved_comments_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_saved_comments" ADD CONSTRAINT "_saved_comments_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
