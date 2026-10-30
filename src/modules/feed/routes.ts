import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../prismaConnection';
import { parse } from '../../lib/http';
import { AuthRequest, optionalAuth } from '../../middlewares/auth';
import { pageQuery, postSort, topWindow } from '../../shared/validation';
import { notMaturePost, viewerContext } from '../communities/access';
import { listPosts } from '../posts/service';

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

export default router;
