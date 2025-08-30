-- AlterTable
ALTER TABLE "public"."Community" ADD COLUMN     "archived_at" TIMESTAMP(3),
ADD COLUMN     "archived_reason" TEXT,
ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "deleted_reason" TEXT,
ADD COLUMN     "is_archived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_deleted" BOOLEAN NOT NULL DEFAULT false;
