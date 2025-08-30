-- AlterEnum
ALTER TYPE "public"."PostStatus" ADD VALUE 'removed';

-- AlterTable
ALTER TABLE "public"."CommunityJoinRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- AlterTable
ALTER TABLE "public"."FollowRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');
