import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../prismaConnection';
import { parse } from '../../lib/http';
import { postInclude } from '../../lib/serializers';
import { AuthRequest, optionalAuth } from '../../middlewares/auth';
import { viewerContext } from '../communities/access';
import { toPublicCommunity } from '../communities/routes';
import { serializePosts } from '../posts/service';
import { ensureFreshTrending } from './service';
import './jobs';

// What's busy right now, from the snapshots the trending job writes every 10 minutes. Items are checked again on
// the way out, so a post removed since the last snapshot never shows.

const router = Router();

const trendingQuery = z.object({
    type: z.enum(['posts', 'communities', 'topics']).default('posts'),
    limit: z.coerce.number().int().min(1).max(50).default(20),
});

router.get('/', optionalAuth, async (request: AuthRequest, response) => {
    const { type, limit } = parse(trendingQuery, request.query);
    await ensureFreshTrending();

    if (type === 'posts') {
        const rows = await prisma.trendingPost.findMany({
            where: {
                post: {
                    status: { in: ['active', 'locked'] },
                    shadow_hidden: false,
                    is_nsfw: false,
                    community: { status: 'active', visibility: 'public', is_nsfw: false },
                },
            },
            orderBy: { rank: 'asc' },
            take: limit,
            include: { post: { include: postInclude } },
        });
        return response.json({
            posts: await serializePosts(rows.map((row) => row.post), await viewerContext(request.viewer)),
            computed_at: rows[0]?.computed_at ?? null,
        });
    }

    if (type === 'communities') {
        const rows = await prisma.trendingCommunity.findMany({
            where: { community: { status: 'active', visibility: 'public', is_nsfw: false } },
            orderBy: { rank: 'asc' },
            take: limit,
            include: { community: true },
        });
        return response.json({
            communities: rows.map((row) => ({
                ...toPublicCommunity(row.community),
                trending: { new_members: row.new_members, posts: row.posts, comments: row.comments },
            })),
            computed_at: rows[0]?.computed_at ?? null,
        });
    }

    const rows = await prisma.trendingTopic.findMany({
        where: { OR: [{ community_id: null }, { community: { status: 'active', visibility: 'public', is_nsfw: false } }] },
        orderBy: { rank: 'asc' },
        take: limit,
        include: { community: { select: { name: true } } },
    });
    response.json({
        topics: rows.map((row) => ({
            kind: row.kind,
            term: row.term,
            community: row.community?.name ?? null,
            posts: row.posts,
            authors: row.authors,
        })),
        computed_at: rows[0]?.computed_at ?? null,
    });
});

export default router;
