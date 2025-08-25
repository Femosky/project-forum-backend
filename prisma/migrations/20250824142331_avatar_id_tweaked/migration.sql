/*
  Warnings:

  - You are about to drop the column `profile_picture_url` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."User" DROP COLUMN "profile_picture_url",
ADD COLUMN     "avatar_id" TEXT NOT NULL DEFAULT 'default_1';
