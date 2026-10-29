import { env } from '../../config/env';
import prisma from '../../prismaConnection';
import { lagosDay } from '../../lib/days';
import logger from '../../lib/logger';

// Counts that change on almost every page view (post and comment views, unique visitors, page views, last-active
// times) are added up in memory and written every METRICS_FLUSH_SECONDS with one statement per table, instead of
// one write per request. No Redis: every increment is additive and every insert is ON CONFLICT DO NOTHING, so
// several API instances each flushing their own buffer still add up correctly. Flushed on shutdown too; a crash
// loses at most one interval of counts, which is fine for numbers that are only ever shown rounded.

// Accounts touch last_active_at at most this often
export const ACTIVE_EVERY_MS = 15 * 60 * 1000;
// Flush early when a buffer gets this big, so a traffic spike can't grow memory without bound
const MAX_ENTRIES = 20_000;

let postViews = new Map<string, number>();
// Key: comment id | post id | viewer id ('' for guests). The post and viewer are checked when written, so a page
// can only count comments that are in its own thread and never the viewer's own.
let commentViews = new Map<string, number>();
let activeUsers = new Set<string>();
let activeDays = new Set<string>();
let visitors = new Map<string, { country: string | null; signedIn: boolean }>();
let communityVisitors = new Set<string>();
let pageViews = new Map<string, number>();
let communityPageViews = new Map<string, number>();

// What has already been queued today, so a visitor or account is written once a day per process, not per request
const lastActive = new Map<string, number>();
const seenToday = new Set<string>();
let seenDay = '';

let timer: ReturnType<typeof setInterval> | null = null;
let flushing: Promise<void> | null = null;

const add = (map: Map<string, number>, key: string, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

function bufferedEntries() {
    return postViews.size + commentViews.size + activeUsers.size + visitors.size + communityVisitors.size + pageViews.size;
}

function maybeFlushEarly() {
    if (bufferedEntries() >= MAX_ENTRIES) void flushMetrics();
}

function firstToday(key: string) {
    const today = lagosDay();
    if (today !== seenDay) {
        seenDay = today;
        seenToday.clear();
    }
    if (seenToday.has(key)) return false;
    seenToday.add(key);
    return true;
}

// A person opened a post: one view for it (unless they wrote it) and one for each listed comment of that thread
export function recordPostView(post: { id: string; author_id: string }, commentIds: string[], viewerId: string | null) {
    if (post.author_id !== viewerId) add(postViews, post.id);
    for (const commentId of commentIds) add(commentViews, `${commentId}|${post.id}|${viewerId ?? ''}`);
    maybeFlushEarly();
}

// A signed-in request. last_active_at moves at most every 15 minutes; the account counts as active once a day.
export function recordActivity(userId: string, now = Date.now()) {
    const previous = lastActive.get(userId);
    if (previous !== undefined && now - previous < ACTIVE_EVERY_MS && lagosDay(new Date(previous)) === lagosDay(new Date(now))) return;
    lastActive.set(userId, now);
    activeUsers.add(userId);
    activeDays.add(`${lagosDay(new Date(now))}|${userId}`);
    maybeFlushEarly();
}

// A page view from a person (bots are filtered before this). community is the page's community name, if any.
export function recordVisit(visit: { visitor: string; country: string | null; signedIn: boolean; community: string | null }) {
    const day = lagosDay();
    add(pageViews, day);
    if (firstToday(`v|${visit.visitor}|${visit.signedIn}`)) {
        const key = `${day}|${visit.visitor}`;
        const queued = visitors.get(key);
        visitors.set(key, { country: visit.country ?? queued?.country ?? null, signedIn: visit.signedIn || Boolean(queued?.signedIn) });
    }
    if (visit.community) {
        add(communityPageViews, `${day}|${visit.community}`);
        if (firstToday(`c|${visit.community}|${visit.visitor}`)) communityVisitors.add(`${day}|${visit.community}|${visit.visitor}`);
    }
    maybeFlushEarly();
}

// Writes everything buffered so far. Concurrent callers share one flush. A failed write puts its counts back to
// be tried again next time.
export function flushMetrics(): Promise<void> {
    flushing ??= writeAll().finally(() => {
        flushing = null;
    });
    return flushing;
}

async function writeAll() {
    const batch = { postViews, commentViews, activeUsers, activeDays, visitors, communityVisitors, pageViews, communityPageViews };
    postViews = new Map();
    commentViews = new Map();
    activeUsers = new Set();
    activeDays = new Set();
    visitors = new Map();
    communityVisitors = new Set();
    pageViews = new Map();
    communityPageViews = new Map();

    // Stale last-active markers go, so the map only holds accounts seen in the last 15 minutes
    const cutoff = Date.now() - ACTIVE_EVERY_MS;
    for (const [userId, at] of lastActive) if (at < cutoff) lastActive.delete(userId);

    const steps: [string, () => Promise<unknown>, () => void][] = [
        ['post views', () => writePostViews(batch.postViews), () => batch.postViews.forEach((n, key) => add(postViews, key, n))],
        ['comment views', () => writeCommentViews(batch.commentViews), () => batch.commentViews.forEach((n, key) => add(commentViews, key, n))],
        ['active users', () => writeActiveUsers(batch.activeUsers, batch.activeDays), () => {
            batch.activeUsers.forEach((id) => activeUsers.add(id));
            batch.activeDays.forEach((key) => activeDays.add(key));
        }],
        ['visitors', () => writeVisitors(batch.visitors), () => batch.visitors.forEach((value, key) => visitors.set(key, value))],
        ['community visitors', () => writeCommunityVisitors(batch.communityVisitors), () => batch.communityVisitors.forEach((key) => communityVisitors.add(key))],
        ['page views', () => writePageViews(batch.pageViews, batch.communityPageViews), () => {
            batch.pageViews.forEach((n, key) => add(pageViews, key, n));
            batch.communityPageViews.forEach((n, key) => add(communityPageViews, key, n));
        }],
    ];
    for (const [name, write, putBack] of steps) {
        try {
            await write();
        } catch (error) {
            logger.warn({ err: error, step: name }, 'Metrics flush failed; will retry');
            putBack();
        }
    }
}

const split = (key: string) => key.split('|');

async function writePostViews(views: Map<string, number>) {
    if (views.size === 0) return;
    const ids = [...views.keys()];
    const counts = ids.map((id) => views.get(id)!);
    await prisma.$executeRaw`
        UPDATE "Post" p SET "view_count" = p."view_count" + v.n
        FROM unnest(${ids}::uuid[], ${counts}::int[]) AS v(id, n)
        WHERE p."id" = v.id`;
}

async function writeCommentViews(views: Map<string, number>) {
    if (views.size === 0) return;
    const rows = [...views].map(([key, n]) => [...split(key), n] as const);
    // Summed per comment first: an UPDATE ... FROM with two source rows for one comment would apply only one
    await prisma.$executeRaw`
        UPDATE "Comment" c SET "view_count" = c."view_count" + agg.n
        FROM (
            SELECT v.id, sum(v.n)::int AS n
            FROM unnest(${rows.map((row) => row[0])}::uuid[], ${rows.map((row) => row[1])}::uuid[],
                        ${rows.map((row) => row[2] || null)}::uuid[], ${rows.map((row) => row[3])}::int[]) AS v(id, post_id, viewer_id, n)
            JOIN "Comment" x ON x."id" = v.id AND x."post_id" = v.post_id AND x."author_id" IS DISTINCT FROM v.viewer_id
            GROUP BY v.id
        ) agg
        WHERE c."id" = agg.id`;
}

async function writeActiveUsers(users: Set<string>, days: Set<string>) {
    if (users.size > 0) {
        await prisma.$executeRaw`UPDATE "User" SET "last_active_at" = now() WHERE "id" = ANY(${[...users]}::uuid[])`;
    }
    if (days.size > 0) {
        const rows = [...days].map(split);
        await prisma.$executeRaw`
            INSERT INTO "DailyActiveUser" ("date", "user_id")
            SELECT v.day, v.user_id FROM unnest(${rows.map((row) => row[0])}::date[], ${rows.map((row) => row[1])}::uuid[]) AS v(day, user_id)
            WHERE EXISTS (SELECT 1 FROM "User" u WHERE u."id" = v.user_id)
            ON CONFLICT DO NOTHING`;
    }
}

async function writeVisitors(rows: Map<string, { country: string | null; signedIn: boolean }>) {
    if (rows.size === 0) return;
    const entries = [...rows].map(([key, value]) => [...split(key), value.country, value.signedIn] as const);
    await prisma.$executeRaw`
        INSERT INTO "DailyVisitor" ("date", "visitor", "country", "signed_in")
        SELECT * FROM unnest(${entries.map((row) => row[0])}::date[], ${entries.map((row) => row[1])}::text[],
                             ${entries.map((row) => row[2])}::text[], ${entries.map((row) => row[3])}::boolean[])
        ON CONFLICT ("date", "visitor") DO UPDATE SET
            "country" = coalesce("DailyVisitor"."country", EXCLUDED."country"),
            "signed_in" = "DailyVisitor"."signed_in" OR EXCLUDED."signed_in"`;
}

async function writeCommunityVisitors(keys: Set<string>) {
    if (keys.size === 0) return;
    const rows = [...keys].map(split);
    await prisma.$executeRaw`
        INSERT INTO "CommunityDailyVisitor" ("date", "community_id", "visitor")
        SELECT v.day, c."id", v.visitor
        FROM unnest(${rows.map((row) => row[0])}::date[], ${rows.map((row) => row[1])}::text[], ${rows.map((row) => row[2])}::text[])
            AS v(day, name, visitor)
        JOIN "Community" c ON c."name" = v.name
        ON CONFLICT DO NOTHING`;
}

async function writePageViews(site: Map<string, number>, communities: Map<string, number>) {
    if (site.size > 0) {
        const days = [...site.keys()];
        await prisma.$executeRaw`
            INSERT INTO "DailyTraffic" ("date", "page_views")
            SELECT * FROM unnest(${days}::date[], ${days.map((day) => site.get(day)!)}::int[])
            ON CONFLICT ("date") DO UPDATE SET "page_views" = "DailyTraffic"."page_views" + EXCLUDED."page_views"`;
    }
    if (communities.size > 0) {
        const rows = [...communities].map(([key, n]) => [...split(key), n] as const);
        await prisma.$executeRaw`
            INSERT INTO "CommunityDailyTraffic" ("date", "community_id", "page_views")
            SELECT v.day, c."id", v.n
            FROM unnest(${rows.map((row) => row[0])}::date[], ${rows.map((row) => row[1])}::text[], ${rows.map((row) => row[2])}::int[])
                AS v(day, name, n)
            JOIN "Community" c ON c."name" = v.name
            ON CONFLICT ("date", "community_id") DO UPDATE SET
                "page_views" = "CommunityDailyTraffic"."page_views" + EXCLUDED."page_views"`;
    }
}

export function startMetricsFlusher() {
    if (timer || env.IS_TEST) return;
    timer = setInterval(() => void flushMetrics(), env.METRICS_FLUSH_SECONDS * 1000);
    // The timer alone never keeps the process alive
    timer.unref();
}

export async function stopMetricsFlusher() {
    if (timer) clearInterval(timer);
    timer = null;
    await flushMetrics();
}

// Tests start each case with nothing buffered and nothing remembered
export function resetMetricsForTests() {
    postViews = new Map();
    commentViews = new Map();
    activeUsers = new Set();
    activeDays = new Set();
    visitors = new Map();
    communityVisitors = new Set();
    pageViews = new Map();
    communityPageViews = new Map();
    lastActive.clear();
    seenToday.clear();
}
