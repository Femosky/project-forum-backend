-- Reddit-style reports: a report names a community rule or a site rule, and community moderators can send a report
-- on to the site's admins. Existing reports count as site-rule reports (admins already saw all of them).

-- CreateEnum
CREATE TYPE "ReportRuleKind" AS ENUM ('community', 'site');

-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "escalated_at" TIMESTAMP(3),
ADD COLUMN     "escalated_by" UUID,
ADD COLUMN     "escalation_note" TEXT,
ADD COLUMN     "rule_kind" "ReportRuleKind" NOT NULL DEFAULT 'site',
ADD COLUMN     "rule_title" TEXT;

-- CreateIndex
CREATE INDEX "Report_status_rule_kind_idx" ON "Report"("status", "rule_kind");

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_escalated_by_fkey" FOREIGN KEY ("escalated_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
