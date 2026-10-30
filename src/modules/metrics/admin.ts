import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../prismaConnection';
import { badRequest, parse } from '../../lib/http';
import { addDays, lagosDay } from '../../lib/days';
import { flushMetrics } from './buffer';
import { dayTotals, ensureDailyStats } from './stats';

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
        SELECT c."name", c."display_name", c."member_count" AS members,
               sum(s."new_members") AS new_members, sum(s."posts") AS posts, sum(s."comments") AS comments,
               sum(s."votes") AS votes, sum(s."unique_visitors") AS visitors, sum(s."page_views") AS page_views
        FROM "CommunityDailyStat" s JOIN "Community" c ON c."id" = s."community_id"
        WHERE s."date" BETWEEN ${from}::date AND ${to}::date
        GROUP BY c."id"
        ORDER BY sum(s."page_views") DESC, sum(s."posts" + s."comments") DESC, c."member_count" DESC
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

router.get('/', async (request, response) => {
    const range = rangeOf(parse(rangeQuery, request.query));
    // This process's buffered visits count towards today's live numbers
    await flushMetrics();
    const [today, days, communities] = await Promise.all([
        dayTotals(lagosDay()),
        series(range.from, range.to),
        topCommunities(range.from, range.to, 20),
    ]);
    response.json({ range, today: { date: lagosDay(), ...today }, days, top_communities: communities });
});

// Spreadsheet-ready CSV: one row per day, or one per community for the range
const exportQuery = rangeQuery.extend({ kind: z.enum(['daily', 'communities']).default('daily') });

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
            : await topCommunities(range.from, range.to, 1000);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="forum-${query.kind}-${range.from}-to-${range.to}.csv"`);
    response.setHeader('Cache-Control', 'private, no-store');
    response.send(toCsv(rows as Record<string, unknown>[]));
});

export default router;
