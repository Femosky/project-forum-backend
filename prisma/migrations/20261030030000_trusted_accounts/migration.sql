-- Accounts the site's admins mark as trusted skip the new-account limits
ALTER TABLE "User" ADD COLUMN "is_trusted" BOOLEAN NOT NULL DEFAULT false;
