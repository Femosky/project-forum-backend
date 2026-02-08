-- DropForeignKey
ALTER TABLE "AuthToken" DROP CONSTRAINT "AuthToken_login_session_id_fkey";

-- DropIndex
DROP INDEX "AuthToken_login_session_id_idx";

-- AlterTable
ALTER TABLE "AuthToken" ALTER COLUMN "login_session_id" DROP NOT NULL,
ALTER COLUMN "refresh_token" DROP NOT NULL;

-- AlterTable
ALTER TABLE "CommunityJoinRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- AlterTable
ALTER TABLE "FollowRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- AddForeignKey
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_login_session_id_fkey" FOREIGN KEY ("login_session_id") REFERENCES "LoginSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
