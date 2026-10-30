import { Prisma } from '@prisma/client';
import prisma from '../../prismaConnection';
import { env } from '../../config/env';
import { defineScheduledJob, onJobsWake } from '../../lib/jobs';
import { Email } from '../../lib/email';
import { unsubscribeHeaders, unsubscribeLink } from '../../lib/emailTokens';
import { SITE_ACCOUNT_NAME } from '../../shared/site';
import { emailJob } from '../auth/jobs';
import { preferencesOf } from './preferences';

// Emails that bring people back: replies and mentions (grouped, at most one per 15 minutes per person) and a digest of
// what's good in their communities. Only people with a confirmed address get them. Nothing here keeps the database
// awake: the jobs run on schedule while the API is up, and catch up when it wakes (lib/jobs.ts).

const REPLY_GAP_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DIGEST_HOUR_LAGOS = 8;
const DIGEST_POSTS = 5;
const DIGEST_MIN_POSTS = 2;
// Sends in a row with no visit afterwards before the digest stops
const DIGEST_MAX_UNOPENED = 8;
const DIGEST_BATCH = 500;
const ENGAGED_DAYS = 30;

const escapeHtml = (value: string) =>
    value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

const plain = (markdown: string, length: number) => {
    const text = markdown.replace(/[*_`~^#>|]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
    return text.length > length ? `${text.slice(0, length).trimEnd()}...` : text;
};

const postUrl = (post: { short_id: string; slug: string | null; community: { name: string } }) =>
    `${env.WEB_URL}/c/${post.community.name}/${post.short_id}${post.slug ? `/${post.slug}` : ''}`;

export async function sendReplyEmails(now = new Date()) {
    const rows = await prisma.notification.findMany({
        where: {
            type: { in: ['post_reply', 'comment_reply', 'mention'] },
            read_at: null,
            emailed_at: null,
            comment: { status: { in: ['active', 'locked'] } },
            user: { status: 'active', email_verified_at: { not: null } },
        },
        orderBy: { created_at: 'asc' },
        take: 2000,
        select: {
            id: true,
            type: true,
            user: { select: { id: true, email: true, notification_preferences: true, last_reply_email_at: true } },
            actor: { select: { username: true } },
            comment: { select: { body: true, short_id: true, is_anonymous: true } },
            post: { select: { title: true, short_id: true, slug: true, community: { select: { name: true } } } },
        },
    });

    const byUser = new Map<string, typeof rows>();
    for (const row of rows) byUser.set(row.user.id, [...(byUser.get(row.user.id) ?? []), row]);

    for (const group of byUser.values()) {
        const { user } = group[0];
        if (user.last_reply_email_at && now.getTime() - user.last_reply_email_at.getTime() < REPLY_GAP_MS) continue;
        const preferences = preferencesOf(user);
        const wanted = group.filter((row) => (row.type === 'mention' ? preferences.email_mentions : preferences.email_replies));
        const ids = group.map((row) => row.id);
        if (wanted.length) {
            const kind = preferences.email_replies ? 'replies' : 'mentions';
            const items = wanted.slice(0, 5).map((row) => {
                const who = row.comment?.is_anonymous ? 'Someone' : (row.actor?.username ?? 'Someone');
                const verb = row.type === 'mention' ? 'mentioned you' : row.type === 'post_reply' ? 'commented on your post' : 'replied to you';
                const url = `${postUrl(row.post!)}?comment=${row.comment!.short_id}#c-${row.comment!.short_id}`;
                return { who, verb, url, title: row.post!.title, excerpt: plain(row.comment!.body, 160) };
            });
            const first = items[0];
            const stop = unsubscribeLink({ kind, userId: user.id });
            const email: Email = {
                to: user.email,
                subject: wanted.length === 1 ? `${first.who} ${first.verb}` : `${wanted.length} new replies on ${SITE_ACCOUNT_NAME}`,
                text: [...items.map((item) => `${item.who} ${item.verb} in "${item.title}":\n${item.excerpt}\n${item.url}`), `Stop these emails: ${stop}`].join('\n\n'),
                html: [
                    ...items.map(
                        (item) =>
                            `<p><strong>${escapeHtml(item.who)}</strong> ${item.verb} in <a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a><br>${escapeHtml(item.excerpt)}</p>`
                    ),
                    `<p style="font-size:12px;color:#777"><a href="${escapeHtml(stop)}">Stop these emails</a></p>`,
                ].join(''),
                headers: unsubscribeHeaders({ kind, userId: user.id }),
            };
            await emailJob.enqueue(email);
        }
        await prisma.$transaction([
            prisma.notification.updateMany({ where: { id: { in: ids } }, data: { emailed_at: now } }),
            ...(wanted.length ? [prisma.user.update({ where: { id: user.id }, data: { last_reply_email_at: now } })] : []),
        ]);
    }
}

export const replyEmailJob = defineScheduledJob('notifications.reply-emails', '*/15 * * * *', () => sendReplyEmails());
onJobsWake('reply-emails', () => sendReplyEmails());

// Communities someone follows or has been active in lately. Views aren't recorded per person, so they don't count.
async function digestCommunities(userId: string, hidden: string[]) {
    const since = new Date(Date.now() - ENGAGED_DAYS * DAY_MS);
    const [joined, voted, commented] = await Promise.all([
        prisma.communityMember.findMany({ where: { user_id: userId, is_banned: false }, select: { community_id: true } }),
        prisma.postVote.findMany({ where: { user_id: userId, created_at: { gte: since }, value: 1 }, select: { post: { select: { community_id: true } } }, take: 200 }),
        prisma.comment.findMany({ where: { author_id: userId, created_at: { gte: since } }, select: { post: { select: { community_id: true } } }, take: 200 }),
    ]);
    const joinedIds = joined.map((row) => row.community_id);
    const ids = new Set([...joinedIds, ...voted.map((row) => row.post.community_id), ...commented.map((row) => row.post.community_id)]);
    return { ids: [...ids], joinedIds, hidden };
}

const digestSelect = {
    id: true,
    title: true,
    body: true,
    short_id: true,
    slug: true,
    score: true,
    comment_count: true,
    is_anonymous: true,
    author: { select: { username: true } },
    community: { select: { name: true } },
} satisfies Prisma.PostSelect;

export function buildDigest(user: { id: string; email: string }, posts: Prisma.PostGetPayload<{ select: typeof digestSelect }>[]): Email {
    const action = { kind: 'digest', userId: user.id };
    const stop = unsubscribeLink(action);
    const items = posts.map((post) => ({
        post,
        url: postUrl(post),
        hide: unsubscribeLink({ kind: 'hide', userId: user.id, ref: post.community.name }),
        by: post.is_anonymous ? 'Anonymous' : post.author.username,
        excerpt: plain(post.body, 180),
    }));
    return {
        to: user.email,
        subject: posts[0].title,
        text: [
            ...items.map(({ post, url, excerpt, hide, by }) =>
                [`c/${post.community.name} · ${by}`, post.title, ...(excerpt ? [excerpt] : []), url, `${post.score} points, ${post.comment_count} comments`, `Hide c/${post.community.name}: ${hide}`].join('\n')
            ),
            `Stop these emails: ${stop}`,
        ].join('\n\n'),
        html: [
            ...items.map(
                ({ post, url, excerpt, hide, by }) => `<div style="margin:0 0 24px;padding:0 0 16px;border-bottom:1px solid #e5e5e5;font-family:sans-serif">
<div style="font-size:13px;color:#666"><strong>c/${escapeHtml(post.community.name)}</strong> · ${escapeHtml(by)}</div>
<div style="font-size:18px;font-weight:700;margin:6px 0"><a href="${escapeHtml(url)}" style="color:#111;text-decoration:none">${escapeHtml(post.title)}</a></div>
${excerpt ? `<div style="font-size:14px;color:#333">${escapeHtml(excerpt)} <a href="${escapeHtml(url)}">Read more</a></div>` : ''}
<div style="font-size:13px;color:#666;margin-top:8px">${post.score} points · ${post.comment_count} comments · <a href="${escapeHtml(hide)}" style="color:#666">Hide c/${escapeHtml(post.community.name)}</a></div>
</div>`
            ),
            `<p style="font-size:12px;color:#777;font-family:sans-serif"><a href="${escapeHtml(stop)}">Stop these emails</a></p>`,
        ].join(''),
        headers: unsubscribeHeaders(action),
    };
}

const lagosHour = (now: Date) => Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Africa/Lagos' }).format(now));

// Runs once a day at a fixed hour, and when the API wakes after that hour; each person's own dates stop a second send
export async function sendDigests(now = new Date()) {
    if (lagosHour(now) < DIGEST_HOUR_LAGOS) return;
    const users = await prisma.user.findMany({
        where: {
            status: 'active',
            email_verified_at: { not: null },
            digest_unopened: { lt: DIGEST_MAX_UNOPENED },
            OR: [{ digest_last_sent_at: null }, { digest_last_sent_at: { lt: new Date(now.getTime() - 20 * 60 * 60 * 1000) } }],
        },
        orderBy: { digest_last_sent_at: { sort: 'asc', nulls: 'first' } },
        take: DIGEST_BATCH,
        select: { id: true, email: true, show_mature: true, notification_preferences: true, digest_last_sent_at: true, digest_unopened: true, last_active_at: true },
    });

    for (const user of users) {
        const preferences = preferencesOf(user);
        if (preferences.digest === 'off') continue;
        const days = preferences.digest === 'daily' ? 1 : 7;
        const last = user.digest_last_sent_at;
        // 20 hours rather than a day, so the send time doesn't creep later
        if (last && now.getTime() - last.getTime() < days * DAY_MS - 4 * 60 * 60 * 1000) continue;

        const { ids, joinedIds, hidden } = await digestCommunities(user.id, preferences.digest_hidden);
        if (!ids.length) continue;
        const posts = await prisma.post.findMany({
            where: {
                community_id: { in: ids },
                community: {
                    name: { notIn: hidden },
                    status: 'active',
                    ...(user.show_mature ? {} : { is_nsfw: false }),
                    OR: [{ visibility: 'public' }, { id: { in: joinedIds } }],
                },
                ...(user.show_mature ? {} : { is_nsfw: false }),
                status: 'active',
                shadow_hidden: false,
                created_at: { gte: new Date(now.getTime() - days * DAY_MS) },
                NOT: { author_id: user.id },
                OR: [{ score: { gte: 2 } }, { comment_count: { gte: 1 } }],
            },
            orderBy: [{ hot_rank: 'desc' }, { id: 'desc' }],
            take: DIGEST_POSTS,
            select: digestSelect,
        });
        // Nothing good this time: no email, and it doesn't count against them
        if (posts.length < DIGEST_MIN_POSTS) continue;

        await emailJob.enqueue(buildDigest(user, posts));
        const visited = Boolean(last && user.last_active_at && user.last_active_at > last);
        await prisma.user.update({
            where: { id: user.id },
            data: { digest_last_sent_at: now, digest_unopened: visited || !last ? 0 : user.digest_unopened + 1 },
        });
    }
}

export const digestJob = defineScheduledJob('notifications.digest', `0 ${DIGEST_HOUR_LAGOS} * * *`, () => sendDigests());
onJobsWake('digest', () => sendDigests());
