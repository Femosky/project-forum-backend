-- Self-promotion: a house campaign can take a share of ad slots even when paid campaigns want them (0-50 percent)
ALTER TABLE "Campaign" ADD COLUMN "house_share" INTEGER NOT NULL DEFAULT 0;

-- Daily stats keep paid ad numbers apart from the site's own house ads
ALTER TABLE "DailyStat" ADD COLUMN "house_impressions" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "DailyStat" ADD COLUMN "house_clicks" INTEGER NOT NULL DEFAULT 0;
