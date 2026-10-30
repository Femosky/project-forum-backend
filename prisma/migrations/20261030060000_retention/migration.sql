-- Reply emails, the digest email, and web push
ALTER TABLE "Notification" ADD COLUMN "emailed_at" TIMESTAMP(3);

ALTER TABLE "User" ADD COLUMN "last_reply_email_at" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "digest_last_sent_at" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "digest_unopened" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "last_trending_push_at" TIMESTAMP(3);

CREATE TABLE "PushSubscription" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX "PushSubscription_user_id_idx" ON "PushSubscription"("user_id");
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
