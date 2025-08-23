/*
  Warnings:

  - You are about to drop the column `permanent_token` on the `AuthToken` table. All the data in the column will be lost.
  - You are about to drop the column `temporary_token` on the `AuthToken` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."AuthToken" DROP COLUMN "permanent_token",
DROP COLUMN "temporary_token",
ADD COLUMN     "long_lived_token" TEXT,
ADD COLUMN     "short_lived_token" TEXT;
