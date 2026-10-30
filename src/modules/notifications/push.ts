import webpush from 'web-push';
import prisma from '../../prismaConnection';
import { env } from '../../config/env';
import { defineJob, defineScheduledJob } from '../../lib/jobs';
import logger from '../../lib/logger';
import { preferencesOf } from './preferences';

// Web push, for people who said yes. Off until the VAPID keys are set. Replies and mentions go out as they happen;
// trending is at most one a day, in the evening.

const TRENDING_GAP_MS = 20 * 60 * 60 * 1000;

export const pushEnabled = () => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

if (pushEnabled()) webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);

type Payload = { title: string; body: string; url: string };

export async function sendPush(userId: string, payload: Payload) {
    if (!pushEnabled()) return;
    const subscriptions = await prisma.pushSubscription.findMany({ where: { user_id: userId } });
    for (const subscription of subscriptions) {
        try {
            await webpush.sendNotification(
                { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
                JSON.stringify(payload),
                { TTL: 24 * 60 * 60 }
            );
        } catch (error) {
            // Gone means the person turned it off in their browser
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) await prisma.pushSubscription.delete({ where: { id: subscription.id } }).catch(() => null);
            else logger.warn({ err: error, userId }, 'Push failed');
        }
    }
}

export const replyPushJob = defineJob<{ userId: string } & Payload>('notifications.push', ({ userId, ...payload }) => sendPush(userId, payload), { retryLimit: 1 });

// Called after a reply or mention notification is created
export async function pushForComment(recipients: { userId: string; title: string }[], body: string, url: string) {
    if (!pushEnabled() || !recipients.length) return;
    const users = await prisma.user.findMany({
        where: { id: { in: recipients.map((recipient) => recipient.userId) }, push_subscriptions: { some: {} } },
        select: { id: true, notification_preferences: true },
    });
    for (const user of users) {
        if (!preferencesOf(user).push_replies) continue;
        await replyPushJob.enqueue({ userId: user.id, title: recipients.find((recipient) => recipient.userId === user.id)!.title, body, url });
    }
}

export async function sendTrendingPushes(now = new Date()) {
    if (!pushEnabled()) return;
    const users = await prisma.user.findMany({
        where: {
            status: 'active',
            push_subscriptions: { some: {} },
            OR: [{ last_trending_push_at: null }, { last_trending_push_at: { lt: new Date(now.getTime() - TRENDING_GAP_MS) } }],
        },
        take: 2000,
        select: { id: true, show_mature: true, notification_preferences: true, memberships: { where: { is_banned: false }, select: { community_id: true } } },
    });
    for (const user of users) {
        if (!preferencesOf(user).push_trending || !user.memberships.length) continue;
        const post = await prisma.post.findFirst({
            where: {
                community_id: { in: user.memberships.map((row) => row.community_id) },
                status: 'active',
                shadow_hidden: false,
                created_at: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
                score: { gte: 3 },
                NOT: { author_id: user.id },
                ...(user.show_mature ? {} : { is_nsfw: false, community: { is_nsfw: false } }),
            },
            orderBy: { hot_rank: 'desc' },
            select: { title: true, short_id: true, slug: true, community: { select: { name: true } } },
        });
        if (!post) continue;
        await sendPush(user.id, {
            title: `Trending in c/${post.community.name}`,
            body: post.title,
            url: `${env.WEB_URL}/c/${post.community.name}/${post.short_id}${post.slug ? `/${post.slug}` : ''}`,
        });
        await prisma.user.update({ where: { id: user.id }, data: { last_trending_push_at: now } });
    }
}

export const trendingPushJob = defineScheduledJob('notifications.trending-push', '0 18 * * *', () => sendTrendingPushes());
