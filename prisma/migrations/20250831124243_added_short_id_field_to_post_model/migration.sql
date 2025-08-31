/*
  Warnings:

  - A unique constraint covering the columns `[short_id]` on the table `Post` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `short_id` to the `Post` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."CommunityJoinRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- AlterTable
ALTER TABLE "public"."FollowRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- AlterTable
ALTER TABLE "public"."Post" ADD COLUMN     "short_id" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Post_short_id_key" ON "public"."Post"("short_id");
