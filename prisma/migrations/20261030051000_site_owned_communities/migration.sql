-- The site's own account (no password, so nobody can sign in to it) owns the launch communities. femi, who owned them,
-- becomes their Lead mod. Touches only these names while femi still owns them, so it's safe to run anywhere.
INSERT INTO "User" ("id", "updated_at", "username", "email", "display_name", "email_verified_at")
VALUES (gen_random_uuid(), now(), 'site_team', 'site-team@invalid.local', 'Project Forum', now())
ON CONFLICT ("username") DO NOTHING;

WITH seeded AS (
    SELECT c."id"
    FROM "Community" c
    JOIN "CommunityMember" m ON m."community_id" = c."id" AND m."role" = 'owner'
    JOIN "User" u ON u."id" = m."user_id" AND u."username" = 'femi'
    WHERE c."name" IN ('elections2027', 'bbnaija', 'supereagles', 'premierleague', 'afrobeats', 'japa', 'lagosrent', 'naijatech',
                       'techcareers', 'moneymatters', 'smallbusiness', 'naijafood', 'studyabroad', 'relationships')
), demoted AS (
    UPDATE "CommunityMember" m SET "role" = 'moderator', "mod_permission" = 'lead'
    FROM seeded WHERE m."community_id" = seeded."id" AND m."role" = 'owner'
    RETURNING m."community_id"
), added AS (
    INSERT INTO "CommunityMember" ("community_id", "user_id", "role")
    SELECT demoted."community_id", s."id", 'owner' FROM demoted CROSS JOIN (SELECT "id" FROM "User" WHERE "username" = 'site_team') s
    ON CONFLICT ("community_id", "user_id") DO UPDATE SET "role" = 'owner'
    RETURNING "community_id"
)
UPDATE "Community" c SET "created_by" = (SELECT "id" FROM "User" WHERE "username" = 'site_team'), "member_count" = c."member_count" + 1
FROM added WHERE c."id" = added."community_id";
