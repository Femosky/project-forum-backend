-- AlterTable
ALTER TABLE "Post" ADD COLUMN "url_key" TEXT;

-- Existing link posts: a close-enough key (lowercased, no scheme, no "www.", no trailing slash); new posts get the full one
UPDATE "Post"
SET "url_key" = regexp_replace(regexp_replace(lower(regexp_replace("url", '^https?://', '')), '^www\.', ''), '/+$', '')
WHERE "url" IS NOT NULL;

-- CreateIndex
CREATE INDEX "Post_url_key_created_at_idx" ON "Post"("url_key", "created_at" DESC);
