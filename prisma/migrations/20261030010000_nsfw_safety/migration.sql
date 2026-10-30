-- NSFW safety: a viewer setting for mature content, and holds only the site's admins can clear
ALTER TABLE "User" ADD COLUMN "show_mature" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Post" ADD COLUMN "held_for_admins" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Comment" ADD COLUMN "held_for_admins" BOOLEAN NOT NULL DEFAULT false;
