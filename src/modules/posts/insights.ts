import prisma from '../../prismaConnection';
import { addDays, lagosDay } from '../../lib/days';
import { forbidden, notFound } from '../../lib/http';
import { flushMetrics } from '../metrics/buffer';

// A post's insights, for its author (and the site's admins): views over time, roughly how many people, shares,
// votes, and where readers are and came from. Daily totals only; nothing here identifies a reader.

const DAYS = 30;
// Country and source breakdowns are kept this long (the nightly stats job prunes older rows)
export const SOURCE_RETENTION_DAYS = 90;
const TOP = 8;

const toDay = (date: Date) => date.toISOString().slice(0, 10);

export async function postInsights(postId: string, viewer: { id: string; role: string }) {
    // This process's buffered views count straight away
    await flushMetrics();
    const post = await prisma.post.findUnique({
        where: { id: postId },
        select: { id: true, author_id: true, status: true, created_at: true, view_count: true, comment_count: true, upvote_count: true, downvote_count: true },
    });
    if (!post || post.status === 'deleted') throw notFound('Post not found');
    if (post.author_id !== viewer.id && viewer.role !== 'admin') throw forbidden('Only the author can see these insights.', 'not_author');

    const today = lagosDay();
    const from = addDays(today, -(DAYS - 1));
    const since = addDays(today, -(SOURCE_RETENTION_DAYS - 1));
    const [days, totals, breakdown] = await Promise.all([
        prisma.postDailyStat.findMany({ where: { post_id: post.id, date: { gte: new Date(`${from}T00:00:00Z`) } }, orderBy: { date: 'asc' } }),
        prisma.postDailyStat.aggregate({ where: { post_id: post.id }, _sum: { readers: true, shares: true }, _min: { date: true } }),
        prisma.postDailySource.groupBy({
            by: ['kind', 'key'],
            where: { post_id: post.id, date: { gte: new Date(`${since}T00:00:00Z`) } },
            _sum: { views: true },
        }),
    ]);

    const byDay = new Map(days.map((row) => [toDay(row.date), row]));
    const series = [];
    for (let day = from; day <= today; day = addDays(day, 1)) {
        const row = byDay.get(day);
        series.push({ date: day, views: row?.views ?? 0, readers: row?.readers ?? 0, shares: row?.shares ?? 0 });
    }
    const top = (kind: 'country' | 'source') => {
        const rows = breakdown.filter((row) => row.kind === kind).map((row) => ({ key: row.key, views: row._sum.views ?? 0 }));
        const total = rows.reduce((sum, row) => sum + row.views, 0);
        return rows
            .sort((a, b) => b.views - a.views)
            .slice(0, TOP)
            .map((row) => ({ ...row, share: total ? row.views / total : 0 }));
    };
    const votes = post.upvote_count + post.downvote_count;

    return {
        totals: {
            // All-time, including views from before insights were collected
            views: post.view_count,
            readers: totals._sum.readers ?? 0,
            shares: totals._sum.shares ?? 0,
            comments: post.comment_count,
            upvotes: post.upvote_count,
            downvotes: post.downvote_count,
            upvote_ratio: votes ? post.upvote_count / votes : null,
        },
        // When daily numbers start (older views are only in the all-time total)
        tracked_since: totals._min.date ? toDay(totals._min.date) : null,
        days: series,
        countries: top('country'),
        sources: top('source'),
        breakdown_days: SOURCE_RETENTION_DAYS,
    };
}
