-- Community names, Reddit style. `name` is the URL key: lowercase letters and digits, unique, never changes
-- (/c/premierleague). `name_styled` is the same letters with the capitals the community chose ("PremierLeague"),
-- shown wherever the handle appears; owners, moderators and admins may change the capitals, nothing else.
-- display_name ("Premier League", free text) stays as it is. citext makes lookups ignore case, so /c/PremierLeague
-- finds the community (and the web app redirects to the lowercase URL).
CREATE EXTENSION IF NOT EXISTS "citext";

-- Old names keep working: /c/{old} answers 301 to the new name
CREATE TABLE "CommunityAlias" (
    "name" CITEXT NOT NULL,
    "community_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommunityAlias_pkey" PRIMARY KEY ("name")
);
CREATE INDEX "CommunityAlias_community_id_idx" ON "CommunityAlias"("community_id");
ALTER TABLE "CommunityAlias" ADD CONSTRAINT "CommunityAlias_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The search vector and trigram index read "name", so they are rebuilt around the type change
DROP INDEX IF EXISTS "Community_search_vector_idx";
ALTER TABLE "Community" DROP COLUMN "search_vector";
DROP INDEX IF EXISTS "Community_name_trgm_idx";

ALTER TABLE "Community" ALTER COLUMN "name" TYPE CITEXT;
ALTER TABLE "Community" ADD COLUMN "name_styled" TEXT;

-- lagos_rent -> name lagosrent, styled LagosRent (old name kept as an alias); japa -> styled Japa. A rename that
-- would collide with another community is skipped (that one keeps its underscores until someone renames it).
WITH styled AS (
    SELECT c."id", c."name"::text AS old_name,
           replace(initcap(regexp_replace(c."name"::text, '[_-]+', ' ', 'g')), ' ', '') AS new_styled
    FROM "Community" c
),
renamed AS (
    SELECT s.* FROM styled s
    WHERE s.old_name ~ '[_-]'
      AND length(s.new_styled) >= 3
      AND NOT EXISTS (SELECT 1 FROM "Community" o WHERE o."name" = lower(s.new_styled)::citext AND o."id" <> s."id")
      AND (SELECT count(*) FROM styled s2 WHERE s2.old_name ~ '[_-]' AND lower(s2.new_styled) = lower(s.new_styled)) = 1
),
aliases AS (
    INSERT INTO "CommunityAlias" ("name", "community_id") SELECT old_name, "id" FROM renamed RETURNING 1
)
UPDATE "Community" c SET
    "name" = CASE WHEN r."id" IS NOT NULL THEN lower(r.new_styled) ELSE lower(c."name"::text) END,
    "name_styled" = CASE WHEN r."id" IS NOT NULL OR c."name"::text !~ '[_-]' THEN s.new_styled END
FROM styled s LEFT JOIN renamed r ON r."id" = s."id"
WHERE c."id" = s."id";

-- The styled name only ever changes capitals
ALTER TABLE "Community" ADD CONSTRAINT "Community_name_lowercase" CHECK ("name"::text = lower("name"::text));
ALTER TABLE "Community" ADD CONSTRAINT "Community_name_styled_matches" CHECK ("name_styled" IS NULL OR lower("name_styled") = "name"::text);

-- Ad targeting lists community names; point them at the new names
UPDATE "Campaign" cp SET "targeting" = jsonb_set(
    cp."targeting",
    '{communities}',
    (SELECT coalesce(jsonb_agg(coalesce(c."name"::text, lower(t.value))), '[]'::jsonb)
     FROM jsonb_array_elements_text(cp."targeting" -> 'communities') AS t(value)
     LEFT JOIN "CommunityAlias" a ON a."name" = t.value::citext
     LEFT JOIN "Community" c ON c."id" = a."community_id")
)
WHERE jsonb_typeof(cp."targeting" -> 'communities') = 'array';

ALTER TABLE "Community" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("name"::text, '') || ' ' || coalesce("display_name", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("description", '')), 'B')
) STORED;
CREATE INDEX "Community_search_vector_idx" ON "Community" USING GIN ("search_vector");
-- Autocomplete and "similar names" (trigram matches on the lowercase name)
CREATE INDEX "Community_name_trgm_idx" ON "Community" USING GIN (("name"::text) gin_trgm_ops);
