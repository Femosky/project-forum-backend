-- View counts on posts and comments, shown to their authors
ALTER TABLE "Post" ADD COLUMN "view_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Comment" ADD COLUMN "view_count" INTEGER NOT NULL DEFAULT 0;
