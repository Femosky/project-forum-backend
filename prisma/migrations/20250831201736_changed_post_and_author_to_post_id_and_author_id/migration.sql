/*
  Warnings:

  - You are about to drop the column `author` on the `Comment` table. All the data in the column will be lost.
  - You are about to drop the column `post` on the `Comment` table. All the data in the column will be lost.
  - You are about to drop the column `author` on the `Post` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[author_id,slug]` on the table `Post` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `author_id` to the `Comment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `post_id` to the `Comment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `author_id` to the `Post` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "public"."Comment" DROP CONSTRAINT "Comment_author_fkey";

-- DropForeignKey
ALTER TABLE "public"."Comment" DROP CONSTRAINT "Comment_post_fkey";

-- DropForeignKey
ALTER TABLE "public"."Post" DROP CONSTRAINT "Post_author_fkey";

-- DropIndex
DROP INDEX "public"."Comment_author_idx";

-- DropIndex
DROP INDEX "public"."Comment_post_idx";

-- DropIndex
DROP INDEX "public"."Post_author_idx";

-- DropIndex
DROP INDEX "public"."Post_author_slug_key";

-- AlterTable
ALTER TABLE "public"."Comment" DROP COLUMN "author",
DROP COLUMN "post",
ADD COLUMN     "author_id" TEXT NOT NULL,
ADD COLUMN     "post_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "public"."CommunityJoinRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- AlterTable
ALTER TABLE "public"."FollowRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- AlterTable
ALTER TABLE "public"."Post" DROP COLUMN "author",
ADD COLUMN     "author_id" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "Comment_author_id_idx" ON "public"."Comment"("author_id");

-- CreateIndex
CREATE INDEX "Comment_post_id_idx" ON "public"."Comment"("post_id");

-- CreateIndex
CREATE INDEX "Post_author_id_idx" ON "public"."Post"("author_id");

-- CreateIndex
CREATE UNIQUE INDEX "Post_author_id_slug_key" ON "public"."Post"("author_id", "slug");

-- AddForeignKey
ALTER TABLE "public"."Post" ADD CONSTRAINT "Post_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Comment" ADD CONSTRAINT "Comment_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Comment" ADD CONSTRAINT "Comment_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."Post"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
