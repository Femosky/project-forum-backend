-- Two launch communities drop "Naija" from their names: naijatech -> tech, naijafood -> food. The old names become
-- aliases, so /c/naijatech/... answers 301 to /c/tech/... and nobody can create a new community called naijatech.
-- Aliases the community already had (naija_tech) keep pointing at it by id, so they follow along.
--
-- Careful by design: a pair is skipped when the old community is missing or the new name is already taken (by a
-- community or an alias of a different one), so the migration is safe on every database and re-runnable.
-- The display name changes only if it is still the launch default ("Naija Tech"); a moderator's own choice stays.
--
-- To undo (by hand, one pair shown):
--   BEGIN;
--   DELETE FROM "CommunityAlias" WHERE "name" = 'naijatech';
--   UPDATE "Community" SET "name" = 'naijatech', "name_styled" = 'NaijaTech', "display_name" = 'Naija Tech' WHERE "name" = 'tech';
--   INSERT INTO "CommunityAlias" ("name", "community_id") SELECT 'tech', "id" FROM "Community" WHERE "name" = 'naijatech';  -- optional: keeps /c/tech links working
--   COMMIT;

CREATE TEMP TABLE "_community_rename" AS
SELECT c."id", r.old_name, r.new_name, r.new_styled, r.old_display, r.new_display
FROM (VALUES
    ('naijatech', 'tech', 'Tech', 'Naija Tech', 'Tech'),
    ('naijafood', 'food', 'Food', 'Naija Food', 'Food')
) AS r(old_name, new_name, new_styled, old_display, new_display)
JOIN "Community" c ON c."name" = r.old_name::citext
WHERE NOT EXISTS (SELECT 1 FROM "Community" o WHERE o."name" = r.new_name::citext)
  AND NOT EXISTS (SELECT 1 FROM "CommunityAlias" a WHERE a."name" = r.new_name::citext AND a."community_id" <> c."id");

-- An alias equal to the new name (only possible for the same community) would shadow nothing; drop it
DELETE FROM "CommunityAlias" a USING "_community_rename" r WHERE a."name" = r.new_name::citext;

INSERT INTO "CommunityAlias" ("name", "community_id")
SELECT r.old_name, r."id" FROM "_community_rename" r
ON CONFLICT ("name") DO NOTHING;

UPDATE "Community" c SET
    "name" = r.new_name,
    "name_styled" = r.new_styled,
    "display_name" = CASE WHEN c."display_name" IS NULL OR c."display_name" = r.old_display THEN r.new_display ELSE c."display_name" END,
    "updated_at" = CURRENT_TIMESTAMP
FROM "_community_rename" r
WHERE c."id" = r."id";

-- Ad targeting lists community names; point them at the new names
UPDATE "Campaign" cp SET "targeting" = jsonb_set(
    cp."targeting",
    '{communities}',
    (SELECT coalesce(jsonb_agg(coalesce(r.new_name, t.value)), '[]'::jsonb)
     FROM jsonb_array_elements_text(cp."targeting" -> 'communities') AS t(value)
     LEFT JOIN "_community_rename" r ON r.old_name = lower(t.value))
)
WHERE jsonb_typeof(cp."targeting" -> 'communities') = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(cp."targeting" -> 'communities') AS t(value)
              JOIN "_community_rename" r ON r.old_name = lower(t.value));

DROP TABLE "_community_rename";
