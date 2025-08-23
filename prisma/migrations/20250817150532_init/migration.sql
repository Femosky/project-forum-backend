-- CreateEnum
CREATE TYPE "public"."UserStatus" AS ENUM ('active', 'suspended', 'banned', 'deleted');

-- CreateEnum
CREATE TYPE "public"."UserType" AS ENUM ('regular', 'business');

-- CreateEnum
CREATE TYPE "public"."CommunityStatus" AS ENUM ('active', 'private', 'archived', 'deleted');

-- CreateEnum
CREATE TYPE "public"."ModeratorRole" AS ENUM ('moderator', 'admin', 'super_moderator');

-- CreateEnum
CREATE TYPE "public"."PostStatus" AS ENUM ('active', 'archived', 'deleted', 'hidden', 'pending');

-- CreateEnum
CREATE TYPE "public"."CommentStatus" AS ENUM ('active', 'archived', 'deleted', 'hidden', 'pending');

-- CreateEnum
CREATE TYPE "public"."TokenType" AS ENUM ('email', 'api');

-- CreateTable
CREATE TABLE "public"."User" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_login" TIMESTAMP(3),
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "profile_picture_url" TEXT,
    "account_status" "public"."UserStatus" NOT NULL DEFAULT 'active',
    "user_type" "public"."UserType" NOT NULL DEFAULT 'regular',
    "is_email_verified" BOOLEAN NOT NULL DEFAULT false,
    "notification_preferences" JSONB,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Community" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "image_url" TEXT,
    "rules" JSONB,
    "status" "public"."CommunityStatus" NOT NULL DEFAULT 'active',
    "seo_metadata" JSONB,
    "preferences" JSONB,

    CONSTRAINT "Community_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Moderator" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "user_id" TEXT NOT NULL,
    "community_id" TEXT NOT NULL,
    "role" "public"."ModeratorRole" NOT NULL DEFAULT 'moderator',
    "permissions" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "added_by" TEXT,

    CONSTRAINT "Moderator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Post" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "is_anonymous" BOOLEAN NOT NULL DEFAULT false,
    "is_sponsored" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[],
    "slug" TEXT NOT NULL,
    "ai_summary" TEXT,
    "status" "public"."PostStatus" NOT NULL DEFAULT 'active',
    "author" TEXT NOT NULL,
    "community" TEXT NOT NULL,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Comment" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "content" TEXT NOT NULL,
    "status" "public"."CommentStatus" NOT NULL DEFAULT 'active',
    "is_anonymous" BOOLEAN NOT NULL DEFAULT false,
    "is_sponsored" BOOLEAN NOT NULL DEFAULT false,
    "author" TEXT NOT NULL,
    "post" TEXT NOT NULL,
    "parent_comment_id" TEXT,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Token" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "type" "public"."TokenType" NOT NULL DEFAULT 'email',
    "email_token" TEXT,
    "valid" BOOLEAN NOT NULL DEFAULT true,
    "expiration" TIMESTAMP(3) NOT NULL,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "Token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."_blocked_users" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_blocked_users_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_joined_communities" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_joined_communities_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_upvoted_posts" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_upvoted_posts_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_downvoted_posts" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_downvoted_posts_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_reported_posts" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_reported_posts_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_saved_posts" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_saved_posts_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_upvoted_comments" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_upvoted_comments_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_downvoted_comments" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_downvoted_comments_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_reported_comments" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_reported_comments_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "public"."User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Community_name_key" ON "public"."Community"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Moderator_user_id_community_id_key" ON "public"."Moderator"("user_id", "community_id");

-- CreateIndex
CREATE UNIQUE INDEX "Post_slug_key" ON "public"."Post"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Token_email_token_key" ON "public"."Token"("email_token");

-- CreateIndex
CREATE INDEX "_blocked_users_B_index" ON "public"."_blocked_users"("B");

-- CreateIndex
CREATE INDEX "_joined_communities_B_index" ON "public"."_joined_communities"("B");

-- CreateIndex
CREATE INDEX "_upvoted_posts_B_index" ON "public"."_upvoted_posts"("B");

-- CreateIndex
CREATE INDEX "_downvoted_posts_B_index" ON "public"."_downvoted_posts"("B");

-- CreateIndex
CREATE INDEX "_reported_posts_B_index" ON "public"."_reported_posts"("B");

-- CreateIndex
CREATE INDEX "_saved_posts_B_index" ON "public"."_saved_posts"("B");

-- CreateIndex
CREATE INDEX "_upvoted_comments_B_index" ON "public"."_upvoted_comments"("B");

-- CreateIndex
CREATE INDEX "_downvoted_comments_B_index" ON "public"."_downvoted_comments"("B");

-- CreateIndex
CREATE INDEX "_reported_comments_B_index" ON "public"."_reported_comments"("B");

-- AddForeignKey
ALTER TABLE "public"."Community" ADD CONSTRAINT "Community_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Moderator" ADD CONSTRAINT "Moderator_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Moderator" ADD CONSTRAINT "Moderator_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "public"."Community"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Moderator" ADD CONSTRAINT "Moderator_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Post" ADD CONSTRAINT "Post_author_fkey" FOREIGN KEY ("author") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Post" ADD CONSTRAINT "Post_community_fkey" FOREIGN KEY ("community") REFERENCES "public"."Community"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Comment" ADD CONSTRAINT "Comment_author_fkey" FOREIGN KEY ("author") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Comment" ADD CONSTRAINT "Comment_post_fkey" FOREIGN KEY ("post") REFERENCES "public"."Post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Comment" ADD CONSTRAINT "Comment_parent_comment_id_fkey" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."Comment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Token" ADD CONSTRAINT "Token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_blocked_users" ADD CONSTRAINT "_blocked_users_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_blocked_users" ADD CONSTRAINT "_blocked_users_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_joined_communities" ADD CONSTRAINT "_joined_communities_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_joined_communities" ADD CONSTRAINT "_joined_communities_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_upvoted_posts" ADD CONSTRAINT "_upvoted_posts_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_upvoted_posts" ADD CONSTRAINT "_upvoted_posts_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_downvoted_posts" ADD CONSTRAINT "_downvoted_posts_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_downvoted_posts" ADD CONSTRAINT "_downvoted_posts_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_reported_posts" ADD CONSTRAINT "_reported_posts_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_reported_posts" ADD CONSTRAINT "_reported_posts_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_saved_posts" ADD CONSTRAINT "_saved_posts_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_saved_posts" ADD CONSTRAINT "_saved_posts_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_upvoted_comments" ADD CONSTRAINT "_upvoted_comments_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_upvoted_comments" ADD CONSTRAINT "_upvoted_comments_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_downvoted_comments" ADD CONSTRAINT "_downvoted_comments_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_downvoted_comments" ADD CONSTRAINT "_downvoted_comments_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_reported_comments" ADD CONSTRAINT "_reported_comments_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_reported_comments" ADD CONSTRAINT "_reported_comments_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
