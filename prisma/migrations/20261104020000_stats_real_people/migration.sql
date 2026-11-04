-- Seed accounts: the launch seed accounts (@seed.invalid) and the site account aren't real people. Stats leave them out.
ALTER TABLE "User" ADD COLUMN "is_seed" BOOLEAN NOT NULL DEFAULT false;
UPDATE "User" SET "is_seed" = true WHERE "email" LIKE '%@seed.invalid' OR "username" = 'site_team';

-- Daily stat snapshots counted the seed accounts as people. They are derived data: the stats page rewrites any
-- missing day from the raw tables, now without the seed accounts.
DELETE FROM "CommunityDailyStat";
DELETE FROM "DailyStat";
