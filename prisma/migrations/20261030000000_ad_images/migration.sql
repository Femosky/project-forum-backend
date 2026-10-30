-- Ad pictures: focal point and fit, one ad in both placements, and the destination's preview image as a fallback
ALTER TYPE "AdFormat" ADD VALUE 'any';

CREATE TYPE "AdImageFit" AS ENUM ('cover', 'contain');

ALTER TABLE "AdCreative"
    ADD COLUMN "image_focus_x" INTEGER NOT NULL DEFAULT 50,
    ADD COLUMN "image_focus_y" INTEGER NOT NULL DEFAULT 50,
    ADD COLUMN "image_fit" "AdImageFit" NOT NULL DEFAULT 'cover',
    ADD COLUMN "use_link_image" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "link_image_url" TEXT,
    ADD COLUMN "link_image_checked_at" TIMESTAMP(3),
    ADD CONSTRAINT "AdCreative_image_focus_range" CHECK ("image_focus_x" BETWEEN 0 AND 100 AND "image_focus_y" BETWEEN 0 AND 100);
