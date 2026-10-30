import { createHmac } from 'node:crypto';
import { NotificationType } from '@prisma/client';
import prisma from '../../prismaConnection';
import { env } from '../../config/env';
import { defineScheduledJob } from '../../lib/jobs';
import { linkEmail } from '../../lib/email';
import logger from '../../lib/logger';
import { safeEqual } from '../../lib/tokens';
import { emailJob } from '../auth/jobs';

// Telling moderators something is waiting. In the app: one unread notification per community and kind, with a running
// count, so a busy community doesn't flood the list. By email: a job every 10 minutes, which also keeps "instant" to
// at most one email per community per 10 minutes. Email only ever reports what's still unread.

const ALERT_TYPES: NotificationType[] = ['mod_queue', 'mod_report', 'mod_join_request'];
const INSTANT_GAP_MS = 10 * 60 * 1000;
const DIGEST_GAP_MS = 24 * 60 * 60 * 1000;
const DESCRIBE: Record<string, string> = { mod_queue: 'held for review', mod_report: 'reported', mod_join_request: 'asking to join' };

async function recordAlert(communityId: string, type: NotificationType) {
    const moderators = await prisma.communityMember.findMany({
        where: { community_id: communityId, role: { in: ['owner', 'moderator'] }, is_banned: false },
        select: { user_id: true, role: true, mod_permission: true },
    });
    // Posts-only moderators don't handle join requests
    const recipients = moderators.filter((mod) => type !== 'mod_join_request' || mod.role === 'owner' || mod.mod_permission !== 'posts').map((mod) => mod.user_id);
    if (!recipients.length) return;
    const where = { community_id: communityId, type, read_at: null, user_id: { in: recipients } };
    const open = await prisma.notification.findMany({ where, select: { user_id: true } });
    const hasOpen = new Set(open.map((row) => row.user_id));
    await prisma.$transaction([
        prisma.notification.updateMany({ where, data: { count: { increment: 1 }, created_at: new Date() } }),
        prisma.notification.createMany({
            data: recipients.filter((id) => !hasOpen.has(id)).map((user_id) => ({ user_id, community_id: communityId, type })),
        }),
    ]);
}

// Never holds up or fails what triggered it
export async function alertModerators(communityId: string, type: NotificationType) {
    await recordAlert(communityId, type).catch((error) => logger.error({ err: error, communityId, type }, 'Moderator alert failed'));
}

// The email's unsubscribe link works without signing in, so it carries a signature instead
const signature = (payload: string) => createHmac('sha256', env.JWT_SECRET).update(`mod-email:${payload}`).digest('base64url');

export function unsubscribeToken(userId: string, communityId: string) {
    const payload = Buffer.from(`${userId}:${communityId}`).toString('base64url');
    return `${payload}.${signature(payload)}`;
}

export function readUnsubscribeToken(token: string) {
    const [payload, given] = token.split('.');
    if (!payload || !given || !safeEqual(given, signature(payload))) return null;
    const [userId, communityId] = Buffer.from(payload, 'base64url').toString().split(':');
    return userId && communityId ? { userId, communityId } : null;
}

export async function sendModeratorEmails(now = new Date()) {
    const rows = await prisma.notification.findMany({
        where: { type: { in: ALERT_TYPES }, read_at: null, community_id: { not: null } },
        select: {
            type: true,
            count: true,
            created_at: true,
            user_id: true,
            community_id: true,
            community: { select: { name: true } },
            user: { select: { email: true, status: true, email_verified_at: true } },
        },
    });

    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
        const key = `${row.user_id}:${row.community_id}`;
        groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    for (const group of groups.values()) {
        const [{ user_id, community_id, community, user }] = group;
        const communityId = community_id!;
        if (user.status !== 'active' || !user.email_verified_at) continue;
        const setting = await prisma.modEmailSetting.findUnique({ where: { community_id_user_id: { community_id: communityId, user_id } } });
        const frequency = setting?.frequency ?? 'daily';
        if (frequency === 'off') continue;
        const lastSent = setting?.last_sent_at?.getTime() ?? 0;
        if (now.getTime() - lastSent < (frequency === 'instant' ? INSTANT_GAP_MS : DIGEST_GAP_MS)) continue;
        if (!group.some((row) => row.created_at.getTime() > lastSent)) continue;

        const summary = group.map((row) => `${row.count} ${DESCRIBE[row.type]}`).join(', ');
        await emailJob.enqueue(
            linkEmail(
                user.email,
                `c/${community!.name}: ${summary}`,
                `Waiting for you in c/${community!.name}: ${summary}.`,
                'Open mod tools',
                `${env.WEB_URL}/c/${community!.name}/mod`,
                `Stop these emails for this community: ${env.WEB_URL}/unsubscribe?token=${unsubscribeToken(user_id, communityId)}`
            )
        );
        await prisma.modEmailSetting.upsert({
            where: { community_id_user_id: { community_id: communityId, user_id } },
            create: { community_id: communityId, user_id, last_sent_at: now },
            update: { last_sent_at: now },
        });
    }
}

export const moderatorEmailJob = defineScheduledJob('moderation.emails', '*/10 * * * *', () => sendModeratorEmails());
