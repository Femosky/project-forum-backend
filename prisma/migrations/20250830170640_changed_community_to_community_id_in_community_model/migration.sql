/*
  Warnings:

  - You are about to drop the column `community` on the `Post` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[community_id,slug]` on the table `Post` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `community_id` to the `Post` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "public"."Post" DROP CONSTRAINT "Post_community_fkey";

-- DropIndex
DROP INDEX "public"."Post_community_idx";

-- DropIndex
DROP INDEX "public"."Post_community_slug_key";

-- AlterTable
ALTER TABLE "public"."CommunityJoinRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- AlterTable
ALTER TABLE "public"."FollowRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- AlterTable
ALTER TABLE "public"."Post" DROP COLUMN "community",
ADD COLUMN     "community_id" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "Post_community_id_idx" ON "public"."Post"("community_id");

-- CreateIndex
CREATE UNIQUE INDEX "Post_community_id_slug_key" ON "public"."Post"("community_id", "slug");

-- AddForeignKey
ALTER TABLE "public"."Post" ADD CONSTRAINT "Post_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "public"."Community"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
