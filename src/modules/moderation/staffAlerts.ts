import prisma from '../../prismaConnection';
import { env } from '../../config/env';
import { linkEmail } from '../../lib/email';
import { defineScheduledJob, onJobsWake } from '../../lib/jobs';
import { emailJob } from '../auth/jobs';

// Tells the site's owner and admins what has reached the site's queue: new reports, and content held for them by the
// automatic checks. At most one email per person per 10 minutes, only when something new arrived. Turned off per
// account from the admin panel. (In the panel itself, the Queue tab shows the count.)

const GAP_MS = 10 * 60 * 1000;

export async function sendStaffAlerts(now = new Date()) {
    const staff = await prisma.staffAccount.findMany({
        where: { role: { in: ['owner', 'admin'] }, disabled_at: null, alert_email: true, password_hash: { not: null } },
        select: { id: true, email: true, last_alert_email_at: true },
    });

    for (const account of staff) {
        const last = account.last_alert_email_at;
        if (last && now.getTime() - last.getTime() < GAP_MS) continue;
        const since = { gt: last ?? new Date(now.getTime() - 24 * 60 * 60 * 1000) };
        const [reports, posts, comments] = await Promise.all([
            prisma.report.count({ where: { status: 'open', created_at: since } }),
            prisma.post.count({ where: { status: 'pending', held_for_admins: true, created_at: since } }),
            prisma.comment.count({ where: { status: 'pending', held_for_admins: true, created_at: since } }),
        ]);
        const held = posts + comments;
        if (reports + held === 0) continue;

        const parts = [...(reports ? [`${reports} new report${reports === 1 ? '' : 's'}`] : []), ...(held ? [`${held} held for review`] : [])];
        const summary = parts.join(', ');
        await emailJob.enqueue(linkEmail(account.email, `Admin queue: ${summary}`, `Waiting in the admin queue: ${summary}.`, 'Open the queue', `${env.WEB_URL}/admin?tab=queue`, 'Turn these off from the Queue tab in the admin panel.'));
        await prisma.staffAccount.update({ where: { id: account.id }, data: { last_alert_email_at: now } });
    }
}

export const staffAlertJob = defineScheduledJob('moderation.staff-alerts', '*/10 * * * *', () => sendStaffAlerts());
onJobsWake('staff-alerts', () => sendStaffAlerts());
