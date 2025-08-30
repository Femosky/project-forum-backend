-- AlterTable
ALTER TABLE "public"."CommunityJoinRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- AlterTable
ALTER TABLE "public"."FollowRequest" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');

-- AlterTable
ALTER TABLE "public"."Post" ADD COLUMN     "is_removed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "removed_at" TIMESTAMP(3),
ADD COLUMN     "removed_reason" TEXT;
