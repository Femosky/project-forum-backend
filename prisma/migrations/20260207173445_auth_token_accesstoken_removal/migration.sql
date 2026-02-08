/*
  Warnings:

  - You are about to drop the column `long_lived_token` on the `AuthToken` table. All the data in the column will be lost.
  - You are about to drop the column `short_lived_token` on the `AuthToken` table. All the data in the column will be lost.
  - Added the required column `login_session_id` to the `AuthToken` table without a default value. This is not possible if the table is not empty.
  - Added the required column `refresh_token` to the `AuthToken` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "AuthToken_valid_idx";

-- AlterTable
ALTER TABLE "AuthToken" DROP COLUMN "long_lived_token",
DROP COLUMN "short_lived_token",
ADD COLUMN     "login_session_id" TEXT NOT NULL,
ADD COLUMN     "refresh_token" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "CommunityJoinRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- AlterTable
ALTER TABLE "FollowRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- CreateIndex
CREATE INDEX "AuthToken_user_id_idx" ON "AuthToken"("user_id");

-- CreateIndex
CREATE INDEX "AuthToken_login_session_id_idx" ON "AuthToken"("login_session_id");

-- AddForeignKey
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_login_session_id_fkey" FOREIGN KEY ("login_session_id") REFERENCES "LoginSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
