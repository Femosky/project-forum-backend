-- Daily stat snapshots counted the launch seed accounts as people. They are derived data: the stats page rewrites
-- any missing day from the raw tables, now without the seed accounts.
DELETE FROM "CommunityDailyStat";
DELETE FROM "DailyStat";
