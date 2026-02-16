-- DropIndex
DROP INDEX "Post_community_id_slug_key";

-- AlterTable
ALTER TABLE "CommunityJoinRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- AlterTable
ALTER TABLE "FollowRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');
