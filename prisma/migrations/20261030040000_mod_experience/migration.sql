-- Moderator permissions, invitations, email settings, and notifications that point at a community
CREATE TYPE "ModPermission" AS ENUM ('all', 'posts');
CREATE TYPE "ModInviteStatus" AS ENUM ('pending', 'accepted', 'declined', 'cancelled');
CREATE TYPE "ModEmailFrequency" AS ENUM ('instant', 'daily', 'off');

ALTER TYPE "NotificationType" ADD VALUE 'mod_queue';
ALTER TYPE "NotificationType" ADD VALUE 'mod_report';
ALTER TYPE "NotificationType" ADD VALUE 'mod_join_request';
ALTER TYPE "NotificationType" ADD VALUE 'mod_invite';

ALTER TABLE "CommunityMember" ADD COLUMN "mod_permission" "ModPermission" NOT NULL DEFAULT 'all';

ALTER TABLE "Notification" ALTER COLUMN "post_id" DROP NOT NULL;
ALTER TABLE "Notification" ALTER COLUMN "comment_id" DROP NOT NULL;
ALTER TABLE "Notification" ADD COLUMN "community_id" UUID;
ALTER TABLE "Notification" ADD COLUMN "count" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX "Notification_community_id_type_read_at_idx" ON "Notification"("community_id", "type", "read_at");
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ModInvite" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "community_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "invited_by" UUID NOT NULL,
    "permission" "ModPermission" NOT NULL DEFAULT 'all',
    "status" "ModInviteStatus" NOT NULL DEFAULT 'pending',
    CONSTRAINT "ModInvite_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ModInvite_community_id_user_id_key" ON "ModInvite"("community_id", "user_id");
CREATE INDEX "ModInvite_user_id_status_idx" ON "ModInvite"("user_id", "status");
ALTER TABLE "ModInvite" ADD CONSTRAINT "ModInvite_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModInvite" ADD CONSTRAINT "ModInvite_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModInvite" ADD CONSTRAINT "ModInvite_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ModEmailSetting" (
    "community_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "frequency" "ModEmailFrequency" NOT NULL DEFAULT 'daily',
    "last_sent_at" TIMESTAMP(3),
    CONSTRAINT "ModEmailSetting_pkey" PRIMARY KEY ("community_id", "user_id")
);
ALTER TABLE "ModEmailSetting" ADD CONSTRAINT "ModEmailSetting_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModEmailSetting" ADD CONSTRAINT "ModEmailSetting_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
