import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../prismaConnection';
import { badRequest, parse } from '../../lib/http';
import { addDays, lagosDay } from '../../lib/days';
import { flushMetrics } from './buffer';
import { REAL_MEMBERS, dayTotals, ensureDailyStats } from './stats';
import { SITE_ACCOUNT_NAME } from '../../shared/site';

// Admin -> Stats (mounted under /v1/admin, so site admins only): headline numbers, daily series, top communities
// and CSV exports for advertiser and marketing decks.

const router = Router();

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;

const rangeQuery = z.object({
    days: z.coerce.number().int().min(1).max(MAX_RANGE_DAYS).optional(),
    from: z.string().regex(DAY).optional(),
    to: z.string().regex(DAY).optional(),
});

// The days asked for: ?days=30 (the 30 days up to yesterday) or ?from=&to=. Never past yesterday, since today
// isn't over; today's live numbers come separately.
function rangeOf(query: z.infer<typeof rangeQuery>) {
    const yesterday = addDays(lagosDay(), -1);
    const to = query.to && query.to < yesterday ? query.to : yesterday;
    const from = query.from ?? addDays(to, -((query.days ?? 30) - 1));
    if (from > to) throw badRequest('The start date must be before the end date.', 'invalid_range');
    if (addDays(from, MAX_RANGE_DAYS) <= to) throw badRequest('Pick a range of a year or less.', 'invalid_range');
    return { from, to };
}

const toDay = (date: Date) => date.toISOString().slice(0, 10);

async function series(from: string, to: string) {
    await ensureDailyStats(from, to);
    const rows = await prisma.dailyStat.findMany({
        where: { date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } },
        orderBy: { date: 'asc' },
    });
    return rows.map(({ date, computed_at, ...row }) => ({ date: toDay(date), ...row }));
}

type CommunityTotals = {
    name: string;
    display_name: string | null;
    members: number;
    new_members: number;
    posts: number;
    comments: number;
    votes: number;
    visitors: number;
    page_views: number;
};

async function topCommunities(from: string, to: string, limit: number) {
    const rows = await prisma.$queryRaw<Record<keyof CommunityTotals, string | number | bigint | null>[]>`
        SELECT c."name", c."display_name", ${REAL_MEMBERS} AS members,
               sum(s."new_members") AS new_members, sum(s."posts") AS posts, sum(s."comments") AS comments,
               sum(s."votes") AS votes, sum(s."unique_visitors") AS visitors, sum(s."page_views") AS page_views
        FROM "CommunityDailyStat" s JOIN "Community" c ON c."id" = s."community_id"
        WHERE s."date" BETWEEN ${from}::date AND ${to}::date
        GROUP BY c."id"
        ORDER BY sum(s."page_views") DESC, sum(s."posts" + s."comments") DESC, members DESC
        LIMIT ${limit}`;
    return rows.map((row) => ({
        ...row,
        members: Number(row.members),
        new_members: Number(row.new_members),
        posts: Number(row.posts),
        comments: Number(row.comments),
        votes: Number(row.votes),
        visitors: Number(row.visitors),
        page_views: Number(row.page_views),
    })) as CommunityTotals[];
}

// Where post readers came from across the site (labels such as Google, WhatsApp, Direct), for the range. Breakdowns
// are kept 90 days, so older ranges come back partly empty.
async function trafficSources(from: string, to: string) {
    const rows = await prisma.$queryRaw<{ key: string; views: bigint }[]>`
        SELECT "key", sum("views") AS views FROM "PostDailySource"
        WHERE "kind" = 'source' AND "date" BETWEEN ${from}::date AND ${to}::date
        GROUP BY "key" ORDER BY views DESC`;
    return rows.map((row) => ({ source: row.key, views: Number(row.views) }));
}

// The most-read posts in the range
async function topPosts(from: string, to: string, limit: number) {
    const rows = await prisma.$queryRaw<
        { title: string; short_id: string; slug: string; community: string; views: bigint; readers: bigint; shares: bigint }[]
    >`
        SELECT p."title", p."short_id", p."slug", c."name" AS community,
               sum(s."views") AS views, sum(s."readers") AS readers, sum(s."shares") AS shares
        FROM "PostDailyStat" s JOIN "Post" p ON p."id" = s."post_id" JOIN "Community" c ON c."id" = p."community_id"
        WHERE s."date" BETWEEN ${from}::date AND ${to}::date AND p."status" IN ('active', 'locked') AND NOT p."shadow_hidden"
        GROUP BY p."id", c."name"
        ORDER BY views DESC
        LIMIT ${limit}`;
    return rows.map((row) => ({ ...row, views: Number(row.views), readers: Number(row.readers), shares: Number(row.shares) }));
}

router.get('/', async (request, response) => {
    const range = rangeOf(parse(rangeQuery, request.query));
    // This process's buffered visits count towards today's live numbers
    await flushMetrics();
    const [today, days, communities, sources, posts] = await Promise.all([
        dayTotals(lagosDay()),
        series(range.from, range.to),
        topCommunities(range.from, range.to, 20),
        trafficSources(range.from, range.to),
        topPosts(range.from, range.to, 10),
    ]);
    response.json({ range, today: { date: lagosDay(), ...today }, days, top_communities: communities, sources, top_posts: posts });
});

// Spreadsheet-ready CSV: one row per day, or one per community for the range
const exportQuery = rangeQuery.extend({ kind: z.enum(['daily', 'communities', 'posts', 'sources']).default('daily') });

const csvCell = (value: unknown) => {
    const text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    // Quoted when needed; a leading = + - @ is defused so spreadsheets don't run it as a formula
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

function toCsv(rows: Record<string, unknown>[]) {
    if (rows.length === 0) return '';
    const columns = Object.keys(rows[0]);
    return [columns.join(','), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))].join('\n') + '\n';
}

router.get('/export', async (request, response) => {
    const query = parse(exportQuery, request.query);
    const range = rangeOf(query);
    const rows =
        query.kind === 'daily'
            ? (await series(range.from, range.to)).map(({ countries, ...row }) => ({ ...row, countries: countries ?? '' }))
            : query.kind === 'communities'
              ? await topCommunities(range.from, range.to, 1000)
              : query.kind === 'posts'
                ? await topPosts(range.from, range.to, 1000)
                : await trafficSources(range.from, range.to);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${SITE_ACCOUNT_NAME.toLowerCase()}-${query.kind}-${range.from}-to-${range.to}.csv"`);
    response.setHeader('Cache-Control', 'private, no-store');
    response.send(toCsv(rows as Record<string, unknown>[]));
});

export default router;
