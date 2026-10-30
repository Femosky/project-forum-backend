-- Lead moderators, and communities waiting for someone to look after them
ALTER TYPE "ModPermission" ADD VALUE 'lead';
ALTER TABLE "Community" ADD COLUMN "needs_moderator" BOOLEAN NOT NULL DEFAULT false;
