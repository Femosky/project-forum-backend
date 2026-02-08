-- DropIndex
DROP INDEX "AuthToken_user_id_idx";

-- AlterTable
ALTER TABLE "CommunityJoinRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- AlterTable
ALTER TABLE "FollowRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- CreateIndex
CREATE INDEX "AuthToken_user_id_valid_idx" ON "AuthToken"("user_id", "valid");
