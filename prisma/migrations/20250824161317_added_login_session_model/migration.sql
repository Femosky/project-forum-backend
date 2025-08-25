-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "deleted_reason" TEXT,
ADD COLUMN     "is_deleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_suspended" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "suspended_at" TIMESTAMP(3),
ADD COLUMN     "suspended_reason" TEXT;

-- CreateTable
CREATE TABLE "public"."LoginSession" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "device_type" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "country" TEXT,
    "city" TEXT,
    "is_trusted" BOOLEAN NOT NULL DEFAULT false,
    "last_activity" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "LoginSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoginSession_user_id_is_active_idx" ON "public"."LoginSession"("user_id", "is_active");

-- CreateIndex
CREATE INDEX "LoginSession_expires_at_idx" ON "public"."LoginSession"("expires_at");

-- AddForeignKey
ALTER TABLE "public"."LoginSession" ADD CONSTRAINT "LoginSession_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
