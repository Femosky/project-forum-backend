import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../prismaConnection';
import { parse } from '../../lib/http';
import { AuthRequest, optionalAuth } from '../../middlewares/auth';
import { pageQuery, postSort, topWindow } from '../../shared/validation';
import { notMaturePost, viewerContext } from '../communities/access';
import { listPosts, serializePosts } from '../posts/service';
import { LISTED_POST_STATUSES, notShadowHidden, postInclude } from '../../lib/serializers';
import { liveWhere } from '../posts/live';

const router = Router();

const feedQuery = pageQuery.extend({
    sort: postSort,
    t: topWindow,
    // home: communities you joined (falls back to all when you have none); all: every public community
    scope: z.enum(['home', 'all']).optional(),
});

router.get('/', optionalAuth, async (request: AuthRequest, response) => {
    const query = parse(feedQuery, request.query);
    const context = await viewerContext(request.viewer);

    let scope = query.scope ?? (request.viewer ? 'home' : 'all');
    let communityIds: string[] = [];
    if (scope === 'home' && request.viewer) {
        const memberships = await prisma.communityMember.findMany({
            where: { user_id: request.viewer.user.id, is_banned: false, community: { status: 'active' } },
            select: { community_id: true },
        });
        communityIds = memberships.map((row) => row.community_id);
    }
    if (communityIds.length === 0) scope = 'all';

    const page = await listPosts({
        where: {
            AND: [
                scope === 'home' ? { community_id: { in: communityIds } } : { community: { visibility: 'public', status: 'active' } },
                // Mature posts only for viewers who switched them on; guests never get them here
                notMaturePost(context),
            ],
        },
        sort: query.sort,
        window: query.t,
        cursor: query.cursor,
        limit: query.limit,
        context,
    });
    response.json({ ...page, scope });
});

// Live threads in public communities for the home page's "Live now" box, busiest first: replies in the last 30
// minutes, then the post's hot rank (votes, replies, age), then the newest start. Same mature rule as the feed.
const LIVE_LIMIT = 6;
const LIVE_CANDIDATES = 300;
const LIVE_ACTIVITY_MINUTES = 30;

router.get('/live', optionalAuth, async (request: AuthRequest, response) => {
    const context = await viewerContext(request.viewer);
    const candidates = await prisma.post.findMany({
        where: {
            AND: [
                liveWhere(),
                { status: { in: LISTED_POST_STATUSES }, community: { visibility: 'public', status: 'active' } },
                notShadowHidden(context),
                notMaturePost(context),
            ],
        },
        orderBy: { live_started_at: 'desc' },
        take: LIVE_CANDIDATES,
        select: { id: true, hot_rank: true, live_started_at: true },
    });
    if (candidates.length === 0) return response.json({ posts: [] });

    const since = new Date(Date.now() - LIVE_ACTIVITY_MINUTES * 60_000);
    const recent = await prisma.comment.groupBy({
        by: ['post_id'],
        where: { post_id: { in: candidates.map((post) => post.id) }, created_at: { gt: since }, status: 'active', shadow_hidden: false },
        _count: { _all: true },
    });
    const activity = new Map(recent.map((row) => [row.post_id, row._count._all]));
    const chosen = candidates
        .sort(
            (a, b) =>
                (activity.get(b.id) ?? 0) - (activity.get(a.id) ?? 0) ||
                b.hot_rank - a.hot_rank ||
                b.live_started_at!.getTime() - a.live_started_at!.getTime()
        )
        .slice(0, LIVE_LIMIT)
        .map((post) => post.id);

    const rows = await prisma.post.findMany({ where: { id: { in: chosen } }, include: postInclude });
    rows.sort((a, b) => chosen.indexOf(a.id) - chosen.indexOf(b.id));
    response.json({ posts: await serializePosts(rows, context) });
});

export default router;
