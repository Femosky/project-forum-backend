/*
  Warnings:

  - A unique constraint covering the columns `[short_id]` on the table `Comment` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `short_id` to the `Comment` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."Comment" ADD COLUMN     "short_id" TEXT NOT NULL,
ADD COLUMN     "slug" TEXT;

-- AlterTable
ALTER TABLE "public"."CommunityJoinRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- AlterTable
ALTER TABLE "public"."FollowRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- CreateIndex
CREATE UNIQUE INDEX "Comment_short_id_key" ON "public"."Comment"("short_id");
