-- Community header banners (uploaded through /v1/images, like the icon in image_url)
ALTER TABLE "Community" ADD COLUMN "banner_url" TEXT;

-- Drawn avatars: which parts make up the picture (lib/avatars.ts). Null until someone edits theirs; until then one
-- is derived from the account id, so everyone already has their own.
ALTER TABLE "User" ADD COLUMN "avatar_config" JSONB;
