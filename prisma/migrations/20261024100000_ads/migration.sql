-- Phase 6: ads. Campaign kinds and pricing, advertiser details, creative call-to-action, per-community ad switch,
-- and ads as a report target.

-- CreateEnum
CREATE TYPE "CampaignKind" AS ENUM ('direct', 'house');

-- CreateEnum
CREATE TYPE "PricingModel" AS ENUM ('cpm', 'flat');

-- AlterEnum
ALTER TYPE "ReportTargetType" ADD VALUE 'ad';

-- AlterTable
ALTER TABLE "AdCreative" ADD COLUMN     "cta_label" TEXT NOT NULL DEFAULT 'Learn more',
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Advertiser" ADD COLUMN     "logo_url" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "website" TEXT;

-- AlterTable
UPDATE "Campaign" SET "currency" = 'NGN' WHERE "currency" IS NULL;
ALTER TABLE "Campaign" ADD COLUMN     "frequency_cap" INTEGER,
ADD COLUMN     "kind" "CampaignKind" NOT NULL DEFAULT 'direct',
ADD COLUMN     "paid_at" TIMESTAMP(3),
ADD COLUMN     "payment_url" TEXT,
ADD COLUMN     "price_minor" INTEGER,
ADD COLUMN     "pricing_model" "PricingModel" NOT NULL DEFAULT 'flat',
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stats_token" TEXT,
ALTER COLUMN "currency" SET NOT NULL,
ALTER COLUMN "currency" SET DEFAULT 'NGN';

-- AlterTable
ALTER TABLE "Community" ADD COLUMN     "ads_enabled" BOOLEAN;

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_stats_token_key" ON "Campaign"("stats_token");
