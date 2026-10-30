-- Emails to site admins about new reports and held content
ALTER TABLE "StaffAccount" ADD COLUMN "alert_email" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "StaffAccount" ADD COLUMN "last_alert_email_at" TIMESTAMP(3);

-- Open reports about a moderator's own posts and comments move to the site's queue
UPDATE "Report" r SET "community_id" = NULL
FROM "Post" p
JOIN "CommunityMember" m ON m."community_id" = p."community_id" AND m."user_id" = p."author_id" AND m."role" IN ('owner', 'moderator')
WHERE r."status" = 'open' AND r."target_type" = 'post' AND r."target_id" = p."id";

UPDATE "Report" r SET "community_id" = NULL
FROM "Comment" c
JOIN "Post" p ON p."id" = c."post_id"
JOIN "CommunityMember" m ON m."community_id" = p."community_id" AND m."user_id" = c."author_id" AND m."role" IN ('owner', 'moderator')
WHERE r."status" = 'open' AND r."target_type" = 'comment' AND r."target_id" = c."id";
