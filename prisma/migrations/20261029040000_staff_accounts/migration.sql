-- Staff accounts for the admin panel, apart from forum accounts: their own sign-in at /admin/login with a password and
-- an authenticator app (two-factor), their own session cookie, and an audit log. A forum account gives no admin
-- access and a staff account has no posting identity. User.role 'admin' stays for now but no longer opens the panel.
CREATE TYPE "StaffRole" AS ENUM ('owner', 'admin', 'ads', 'moderator');

CREATE TABLE "StaffAccount" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "email" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL DEFAULT 'moderator',
    "password_hash" TEXT,
    "password_temporary" BOOLEAN NOT NULL DEFAULT false,
    "totp_secret" TEXT,
    "totp_enabled_at" TIMESTAMP(3),
    "recovery_codes" JSONB,
    "disabled_at" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_by" UUID,
    CONSTRAINT "StaffAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffAccount_email_key" ON "StaffAccount"("email");
ALTER TABLE "StaffAccount" ADD CONSTRAINT "StaffAccount_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "StaffAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "StaffSession" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "staff_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mfa_verified_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "ip_address" TEXT,
    "user_agent" TEXT,
    CONSTRAINT "StaffSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffSession_token_hash_key" ON "StaffSession"("token_hash");
CREATE INDEX "StaffSession_staff_id_idx" ON "StaffSession"("staff_id");
ALTER TABLE "StaffSession" ADD CONSTRAINT "StaffSession_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "StaffAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One-time links: invites (set a password) and resets
CREATE TABLE "StaffToken" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "staff_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    CONSTRAINT "StaffToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffToken_token_hash_key" ON "StaffToken"("token_hash");
CREATE INDEX "StaffToken_staff_id_idx" ON "StaffToken"("staff_id");
ALTER TABLE "StaffToken" ADD CONSTRAINT "StaffToken_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "StaffAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Who did what in the admin panel, sign-ins included
CREATE TABLE "StaffAudit" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "staff_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "details" JSONB,
    "ip_address" TEXT,
    CONSTRAINT "StaffAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StaffAudit_created_at_idx" ON "StaffAudit"("created_at" DESC);
CREATE INDEX "StaffAudit_staff_id_created_at_idx" ON "StaffAudit"("staff_id", "created_at" DESC);
ALTER TABLE "StaffAudit" ADD CONSTRAINT "StaffAudit_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "StaffAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Staff decisions appear in moderation logs and close reports like moderators' do
ALTER TABLE "ModAction" ALTER COLUMN "actor_id" DROP NOT NULL;
ALTER TABLE "ModAction" ADD COLUMN "staff_id" UUID;
ALTER TABLE "ModAction" ADD CONSTRAINT "ModAction_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "StaffAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Report" ADD COLUMN "resolved_by_staff" UUID;
ALTER TABLE "Report" ADD CONSTRAINT "Report_resolved_by_staff_fkey" FOREIGN KEY ("resolved_by_staff") REFERENCES "StaffAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BlockedTerm" ALTER COLUMN "created_by" DROP NOT NULL;
ALTER TABLE "BlockedTerm" ADD COLUMN "created_by_staff" UUID;
ALTER TABLE "BlockedTerm" ADD CONSTRAINT "BlockedTerm_created_by_staff_fkey" FOREIGN KEY ("created_by_staff") REFERENCES "StaffAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
