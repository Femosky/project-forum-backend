/*
  Warnings:

  - You are about to drop the `_blocked_users` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `_reported_comments` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `_reported_posts` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[author,slug]` on the table `Post` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[community,slug]` on the table `Post` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "public"."ReportType" AS ENUM ('community', 'post', 'comment', 'user', 'chat');

-- CreateEnum
CREATE TYPE "public"."ReportStatus" AS ENUM ('pending', 'resolved');

-- DropForeignKey
ALTER TABLE "public"."_blocked_users" DROP CONSTRAINT "_blocked_users_A_fkey";

-- DropForeignKey
ALTER TABLE "public"."_blocked_users" DROP CONSTRAINT "_blocked_users_B_fkey";

-- DropForeignKey
ALTER TABLE "public"."_reported_comments" DROP CONSTRAINT "_reported_comments_A_fkey";

-- DropForeignKey
ALTER TABLE "public"."_reported_comments" DROP CONSTRAINT "_reported_comments_B_fkey";

-- DropForeignKey
ALTER TABLE "public"."_reported_posts" DROP CONSTRAINT "_reported_posts_A_fkey";

-- DropForeignKey
ALTER TABLE "public"."_reported_posts" DROP CONSTRAINT "_reported_posts_B_fkey";

-- DropTable
DROP TABLE "public"."_blocked_users";

-- DropTable
DROP TABLE "public"."_reported_comments";

-- DropTable
DROP TABLE "public"."_reported_posts";

-- CreateTable
CREATE TABLE "public"."Follow" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "follower_id" TEXT NOT NULL,
    "followee_id" TEXT NOT NULL,

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."FollowRequest" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "response_at" TIMESTAMP(3),
    "requester_id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "response_message" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL DEFAULT (now() + interval '30 days'),

    CONSTRAINT "FollowRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CommunityJoinRequest" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "requester_id" TEXT NOT NULL,
    "community_id" TEXT NOT NULL,
    "response_at" TIMESTAMP(3),
    "response_by" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL DEFAULT (now() + interval '30 days'),
    "request_message" TEXT,
    "response_message" TEXT,

    CONSTRAINT "CommunityJoinRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Block" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "blocker_id" TEXT NOT NULL,
    "blocked_id" TEXT NOT NULL,

    CONSTRAINT "Block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Report" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "report_type" "public"."ReportType" NOT NULL,
    "report_message" TEXT NOT NULL,
    "report_status" "public"."ReportStatus" NOT NULL DEFAULT 'pending',
    "reporter_id" TEXT NOT NULL,
    "reported_id" TEXT NOT NULL,
    "post_id" TEXT,
    "comment_id" TEXT,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Follow_follower_id_idx" ON "public"."Follow"("follower_id");

-- CreateIndex
CREATE INDEX "Follow_followee_id_idx" ON "public"."Follow"("followee_id");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_follower_id_followee_id_key" ON "public"."Follow"("follower_id", "followee_id");

-- CreateIndex
CREATE INDEX "FollowRequest_requester_id_idx" ON "public"."FollowRequest"("requester_id");

-- CreateIndex
CREATE INDEX "FollowRequest_target_id_idx" ON "public"."FollowRequest"("target_id");

-- CreateIndex
CREATE UNIQUE INDEX "FollowRequest_requester_id_target_id_key" ON "public"."FollowRequest"("requester_id", "target_id");

-- CreateIndex
CREATE INDEX "CommunityJoinRequest_requester_id_idx" ON "public"."CommunityJoinRequest"("requester_id");

-- CreateIndex
CREATE INDEX "CommunityJoinRequest_community_id_idx" ON "public"."CommunityJoinRequest"("community_id");

-- CreateIndex
CREATE INDEX "CommunityJoinRequest_expires_at_idx" ON "public"."CommunityJoinRequest"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "CommunityJoinRequest_requester_id_community_id_key" ON "public"."CommunityJoinRequest"("requester_id", "community_id");

-- CreateIndex
CREATE INDEX "Block_blocker_id_idx" ON "public"."Block"("blocker_id");

-- CreateIndex
CREATE INDEX "Block_blocked_id_idx" ON "public"."Block"("blocked_id");

-- CreateIndex
CREATE UNIQUE INDEX "Block_blocker_id_blocked_id_key" ON "public"."Block"("blocker_id", "blocked_id");

-- CreateIndex
CREATE INDEX "Report_reporter_id_idx" ON "public"."Report"("reporter_id");

-- CreateIndex
CREATE INDEX "Report_reported_id_idx" ON "public"."Report"("reported_id");

-- CreateIndex
CREATE INDEX "Report_report_type_idx" ON "public"."Report"("report_type");

-- CreateIndex
CREATE INDEX "Report_report_status_idx" ON "public"."Report"("report_status");

-- CreateIndex
CREATE INDEX "Report_created_at_idx" ON "public"."Report"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "Report_reporter_id_reported_id_post_id_comment_id_key" ON "public"."Report"("reporter_id", "reported_id", "post_id", "comment_id");

-- CreateIndex
CREATE INDEX "AuthToken_valid_idx" ON "public"."AuthToken"("valid");

-- CreateIndex
CREATE INDEX "Comment_author_idx" ON "public"."Comment"("author");

-- CreateIndex
CREATE INDEX "Comment_post_idx" ON "public"."Comment"("post");

-- CreateIndex
CREATE INDEX "Comment_parent_comment_id_idx" ON "public"."Comment"("parent_comment_id");

-- CreateIndex
CREATE INDEX "Comment_status_idx" ON "public"."Comment"("status");

-- CreateIndex
CREATE INDEX "Comment_created_at_idx" ON "public"."Comment"("created_at");

-- CreateIndex
CREATE INDEX "Community_status_idx" ON "public"."Community"("status");

-- CreateIndex
CREATE INDEX "Community_is_deleted_idx" ON "public"."Community"("is_deleted");

-- CreateIndex
CREATE INDEX "Community_created_by_idx" ON "public"."Community"("created_by");

-- CreateIndex
CREATE INDEX "Community_is_archived_idx" ON "public"."Community"("is_archived");

-- CreateIndex
CREATE INDEX "Moderator_user_id_idx" ON "public"."Moderator"("user_id");

-- CreateIndex
CREATE INDEX "Moderator_community_id_idx" ON "public"."Moderator"("community_id");

-- CreateIndex
CREATE INDEX "Post_author_idx" ON "public"."Post"("author");

-- CreateIndex
CREATE INDEX "Post_community_idx" ON "public"."Post"("community");

-- CreateIndex
CREATE INDEX "Post_status_idx" ON "public"."Post"("status");

-- CreateIndex
CREATE INDEX "Post_created_at_idx" ON "public"."Post"("created_at");

-- CreateIndex
CREATE INDEX "Post_slug_idx" ON "public"."Post"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Post_author_slug_key" ON "public"."Post"("author", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Post_community_slug_key" ON "public"."Post"("community", "slug");

-- CreateIndex
CREATE INDEX "Token_expiration_idx" ON "public"."Token"("expiration");

-- CreateIndex
CREATE INDEX "Token_valid_idx" ON "public"."Token"("valid");

-- CreateIndex
CREATE INDEX "User_username_idx" ON "public"."User"("username");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "public"."User"("email");

-- CreateIndex
CREATE INDEX "User_account_status_idx" ON "public"."User"("account_status");

-- CreateIndex
CREATE INDEX "User_is_deleted_idx" ON "public"."User"("is_deleted");

-- CreateIndex
CREATE INDEX "User_is_suspended_idx" ON "public"."User"("is_suspended");

-- AddForeignKey
ALTER TABLE "public"."Follow" ADD CONSTRAINT "Follow_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Follow" ADD CONSTRAINT "Follow_followee_id_fkey" FOREIGN KEY ("followee_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FollowRequest" ADD CONSTRAINT "FollowRequest_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FollowRequest" ADD CONSTRAINT "FollowRequest_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CommunityJoinRequest" ADD CONSTRAINT "CommunityJoinRequest_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CommunityJoinRequest" ADD CONSTRAINT "CommunityJoinRequest_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "public"."Community"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Block" ADD CONSTRAINT "Block_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Block" ADD CONSTRAINT "Block_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Report" ADD CONSTRAINT "Report_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Report" ADD CONSTRAINT "Report_reported_id_fkey" FOREIGN KEY ("reported_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Report" ADD CONSTRAINT "Report_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Report" ADD CONSTRAINT "Report_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "public"."Comment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
