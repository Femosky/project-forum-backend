import prisma from '../../prismaConnection';
import { addDays, lagosDay, lagosDayBounds } from '../../lib/days';
import { defineScheduledJob } from '../../lib/jobs';
import logger from '../../lib/logger';
import { flushMetrics } from './buffer';

// Daily snapshots for Admin -> Stats and advertiser decks: one DailyStat row per Lagos day plus one
// CommunityDailyStat row per community that had anything going on. Written nightly for the day before; when the
// job queue is off (JOBS_ENABLED=false) the stats page fills in missing days itself (ensureDailyStats).
//
// Counted: visible content only (not held, removed or shadow-hidden), people only (visitors come from page-view
// beacons with bots filtered out), active accounts by their own signed-in requests.

type Totals = {
    total_users: number;
    new_signups: number;
    dau: number;
    wau: number;
    mau: number;
    unique_visitors: number;
    page_views: number;
    posts: number;
    comments: number;
    votes: number;
    ad_impressions: number;
    ad_clicks: number;
    house_impressions: number;
    house_clicks: number;
};

const VISIBLE = `"status" IN ('active', 'locked') AND NOT "shadow_hidden"`;

// A Lagos day's start and end as UTC timestamps without a zone, like the created_at columns. Passed as text and
// cast in SQL, so the database session's time zone can't shift them.
function utcBounds(day: string) {
    const { start, end } = lagosDayBounds(day);
    const plain = (date: Date) => date.toISOString().replace('T', ' ').replace('Z', '');
    return { start: plain(start), end: plain(end) };
}

// Live numbers for one day (today's are partial). Each is one indexed count.
export async function dayTotals(day: string): Promise<Totals & { countries: Record<string, number> }> {
    const { start, end } = utcBounds(day);
    const [[row], countries] = await Promise.all([
        prisma.$queryRawUnsafe<Record<keyof Totals, bigint | number>[]>(
            `SELECT
                (SELECT count(*) FROM "User" WHERE "status" <> 'deleted' AND "created_at" < $2::timestamp) AS total_users,
                (SELECT count(*) FROM "User" WHERE "created_at" >= $1::timestamp AND "created_at" < $2::timestamp) AS new_signups,
                (SELECT count(*) FROM "DailyActiveUser" WHERE "date" = $3::date) AS dau,
                (SELECT count(DISTINCT "user_id") FROM "DailyActiveUser" WHERE "date" > $3::date - 7 AND "date" <= $3::date) AS wau,
                (SELECT count(DISTINCT "user_id") FROM "DailyActiveUser" WHERE "date" > $3::date - 30 AND "date" <= $3::date) AS mau,
                (SELECT count(*) FROM "DailyVisitor" WHERE "date" = $3::date) AS unique_visitors,
                (SELECT coalesce(sum("page_views"), 0) FROM "DailyTraffic" WHERE "date" = $3::date) AS page_views,
                (SELECT count(*) FROM "Post" WHERE "created_at" >= $1::timestamp AND "created_at" < $2::timestamp AND ${VISIBLE}) AS posts,
                (SELECT count(*) FROM "Comment" WHERE "created_at" >= $1::timestamp AND "created_at" < $2::timestamp AND ${VISIBLE}) AS comments,
                (SELECT count(*) FROM "PostVote" WHERE "created_at" >= $1::timestamp AND "created_at" < $2::timestamp)
                    + (SELECT count(*) FROM "CommentVote" WHERE "created_at" >= $1::timestamp AND "created_at" < $2::timestamp) AS votes,
                (SELECT coalesce(sum(s."impressions"), 0) FROM "AdDailyStat" s JOIN "AdCreative" a ON a."id" = s."creative_id"
                    JOIN "Campaign" c ON c."id" = a."campaign_id" WHERE s."date" = $3::date AND c."kind" = 'direct') AS ad_impressions,
                (SELECT coalesce(sum(s."clicks"), 0) FROM "AdDailyStat" s JOIN "AdCreative" a ON a."id" = s."creative_id"
                    JOIN "Campaign" c ON c."id" = a."campaign_id" WHERE s."date" = $3::date AND c."kind" = 'direct') AS ad_clicks,
                (SELECT coalesce(sum(s."impressions"), 0) FROM "AdDailyStat" s JOIN "AdCreative" a ON a."id" = s."creative_id"
                    JOIN "Campaign" c ON c."id" = a."campaign_id" WHERE s."date" = $3::date AND c."kind" = 'house') AS house_impressions,
                (SELECT coalesce(sum(s."clicks"), 0) FROM "AdDailyStat" s JOIN "AdCreative" a ON a."id" = s."creative_id"
                    JOIN "Campaign" c ON c."id" = a."campaign_id" WHERE s."date" = $3::date AND c."kind" = 'house') AS house_clicks`,
            start,
            end,
            day
        ),
        prisma.$queryRaw<{ country: string | null; n: bigint }[]>`
            SELECT "country", count(*) AS n FROM "DailyVisitor" WHERE "date" = ${day}::date GROUP BY 1 ORDER BY 2 DESC LIMIT 30`,
    ]);
    const totals = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)])) as Totals;
    return { ...totals, countries: Object.fromEntries(countries.map((item) => [item.country ?? 'unknown', Number(item.n)])) };
}

// Writes (or rewrites) the snapshot rows for one day
export async function writeDailyStats(day: string) {
    const totals = await dayTotals(day);
    const { countries, ...numbers } = totals;
    await prisma.dailyStat.upsert({
        where: { date: new Date(`${day}T00:00:00Z`) },
        create: { date: new Date(`${day}T00:00:00Z`), ...numbers, countries, computed_at: new Date() },
        update: { ...numbers, countries, computed_at: new Date() },
    });

    const { start, end } = utcBounds(day);
    await prisma.$transaction([
        prisma.$executeRaw`DELETE FROM "CommunityDailyStat" WHERE "date" = ${day}::date`,
        prisma.$executeRaw`
            WITH posts AS (
                SELECT "community_id", count(*) AS n FROM "Post"
                WHERE "created_at" >= ${start}::timestamp AND "created_at" < ${end}::timestamp AND "status" IN ('active', 'locked') AND NOT "shadow_hidden"
                GROUP BY 1),
            comments AS (
                SELECT p."community_id", count(*) AS n FROM "Comment" c JOIN "Post" p ON p."id" = c."post_id"
                WHERE c."created_at" >= ${start}::timestamp AND c."created_at" < ${end}::timestamp AND c."status" IN ('active', 'locked') AND NOT c."shadow_hidden"
                GROUP BY 1),
            votes AS (
                SELECT p."community_id", count(*) AS n FROM "PostVote" v JOIN "Post" p ON p."id" = v."post_id"
                WHERE v."created_at" >= ${start}::timestamp AND v."created_at" < ${end}::timestamp GROUP BY 1
                UNION ALL
                SELECT p."community_id", count(*) FROM "CommentVote" v JOIN "Comment" c ON c."id" = v."comment_id" JOIN "Post" p ON p."id" = c."post_id"
                WHERE v."created_at" >= ${start}::timestamp AND v."created_at" < ${end}::timestamp GROUP BY 1),
            joins AS (
                SELECT "community_id", count(*) AS n FROM "CommunityMember"
                WHERE "joined_at" >= ${start}::timestamp AND "joined_at" < ${end}::timestamp AND NOT "is_banned" GROUP BY 1),
            visitors AS (
                SELECT "community_id", count(*) AS n FROM "CommunityDailyVisitor" WHERE "date" = ${day}::date GROUP BY 1),
            traffic AS (
                SELECT "community_id", "page_views" AS n FROM "CommunityDailyTraffic" WHERE "date" = ${day}::date)
            INSERT INTO "CommunityDailyStat"
                ("date", "community_id", "members", "new_members", "posts", "comments", "votes", "unique_visitors", "page_views")
            SELECT ${day}::date, c."id", c."member_count",
                   coalesce(j.n, 0), coalesce(p.n, 0), coalesce(cm.n, 0), coalesce((SELECT sum(n) FROM votes v WHERE v."community_id" = c."id"), 0),
                   coalesce(vi.n, 0), coalesce(t.n, 0)
            FROM "Community" c
            LEFT JOIN joins j ON j."community_id" = c."id"
            LEFT JOIN posts p ON p."community_id" = c."id"
            LEFT JOIN comments cm ON cm."community_id" = c."id"
            LEFT JOIN visitors vi ON vi."community_id" = c."id"
            LEFT JOIN traffic t ON t."community_id" = c."id"
            WHERE c."status" <> 'deleted'
              AND (j.n IS NOT NULL OR p.n IS NOT NULL OR cm.n IS NOT NULL OR vi.n IS NOT NULL OR t.n IS NOT NULL
                   OR EXISTS (SELECT 1 FROM votes v WHERE v."community_id" = c."id"))`,
    ]);
}

// Missing snapshots between two days (inclusive, never today) are written, oldest first. Lets the stats page
// work on a deploy without the job queue, and fills gaps after downtime.
export async function ensureDailyStats(from: string, to: string) {
    const yesterday = addDays(lagosDay(), -1);
    const last = to < yesterday ? to : yesterday;
    if (from > last) return;
    const existing = await prisma.$queryRaw<{ day: string }[]>`
        SELECT to_char("date", 'YYYY-MM-DD') AS day FROM "DailyStat" WHERE "date" BETWEEN ${from}::date AND ${last}::date`;
    const have = new Set(existing.map((row) => row.day));
    for (let day = from; day <= last; day = addDays(day, 1)) {
        if (!have.has(day)) await writeDailyStats(day);
    }
}

// Nightly at 00:20 Lagos time: write yesterday's numbers (after a final flush of this process's buffer), then drop
// salts nothing needs any more so yesterday's visitor ids can never be recomputed
export const dailyStatsJob = defineScheduledJob('stats.daily', '20 0 * * *', async () => {
    await flushMetrics();
    const yesterday = addDays(lagosDay(), -1);
    await writeDailyStats(yesterday);
    await prisma.$executeRaw`DELETE FROM "DailySalt" WHERE "date" < ${yesterday}::date`;
    logger.info({ day: yesterday }, 'Daily stats written');
});
