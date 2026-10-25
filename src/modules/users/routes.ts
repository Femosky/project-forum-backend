import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../prismaConnection';
import { afterCursor, decodeCursor, paginate } from '../../lib/cursor';
import { badRequest, notFound, parse } from '../../lib/http';
import { commentInclude, notShadowHidden, postInclude, READABLE_POST_WHERE, toPublicComment } from '../../lib/serializers';
import { AuthRequest, optionalAuth, requireAuth, viewerOf } from '../../middlewares/auth';
import { LIMITS, pageQuery } from '../../shared/validation';
import { revokeAllSessions, toPrivateUser, verifyPassword } from '../auth/service';
import { clearAuthCookies } from '../auth/tokens';
import { toPublicCommunity } from '../communities/routes';
import { viewerContext } from '../communities/access';
import { listPosts, serializePosts } from '../posts/service';
import { commentViewerState } from '../votes/service';

const router = Router();

export const AVATAR_IDS = ['default_1', 'default_2', 'default_3'] as const;

const updateMeSchema = z
    .object({
        display_name: z.string().trim().max(LIMITS.DISPLAY_NAME_MAX).nullable().optional(),
        avatar_id: z.enum(AVATAR_IDS).optional(),
    })
    .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

const savedQuery = pageQuery.extend({ type: z.enum(['posts', 'comments']).default('posts') });

// --- The signed-in user ---

router.patch('/me', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const input = parse(updateMeSchema, request.body);
    const updated = await prisma.user.update({
        where: { id: user.id },
        data: { ...input, display_name: input.display_name === '' ? null : input.display_name },
    });
    response.json({ user: toPrivateUser(updated) });
});

// Numbers for the signed-in user's own profile: what they've written and how it was received
router.get('/me/stats', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const live = { author_id: user.id, status: { notIn: ['deleted' as const, 'removed' as const] } };
    const [posts, comments] = await Promise.all([
        prisma.post.aggregate({ where: live, _count: true, _sum: { upvote_count: true, downvote_count: true, view_count: true } }),
        prisma.comment.aggregate({ where: live, _count: true, _sum: { upvote_count: true, downvote_count: true, view_count: true } }),
    ]);
    response.json({
        stats: {
            posts: posts._count,
            comments: comments._count,
            upvotes_received: (posts._sum.upvote_count ?? 0) + (comments._sum.upvote_count ?? 0),
            downvotes_received: (posts._sum.downvote_count ?? 0) + (comments._sum.downvote_count ?? 0),
            views: (posts._sum.view_count ?? 0) + (comments._sum.view_count ?? 0),
        },
    });
});

router.get('/me/communities', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const rows = await prisma.communityMember.findMany({
        where: { user_id: user.id, is_banned: false, community: { status: { not: 'deleted' } } },
        orderBy: { joined_at: 'desc' },
        take: 500,
        include: { community: true },
    });
    response.json({ communities: rows.map((row) => ({ ...toPublicCommunity(row.community), role: row.role })) });
});

router.get('/me/saved', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const query = parse(savedQuery, request.query);
    const context = await viewerContext(request.viewer);
    const cursor = decodeCursor(query.cursor);

    if (query.type === 'posts') {
        const rows = await prisma.savedPost.findMany({
            where: {
                user_id: user.id,
                post: READABLE_POST_WHERE,
                ...(cursor ? { OR: [{ created_at: { lt: cursor.value as Date } }, { created_at: cursor.value as Date, post_id: { lt: cursor.id } }] } : {}),
            },
            orderBy: [{ created_at: 'desc' }, { post_id: 'desc' }],
            take: query.limit + 1,
            include: { post: { include: postInclude } },
        });
        const { items, next_cursor } = paginate(rows.map((row) => ({ ...row, id: row.post_id })), query.limit, 'created_at');
        return response.json({ posts: await serializePosts(items.map((row) => row.post), context), next_cursor });
    }

    const rows = await prisma.savedComment.findMany({
        where: {
            user_id: user.id,
            comment: { status: { in: ['active', 'locked'] } },
            ...(cursor ? { OR: [{ created_at: { lt: cursor.value as Date } }, { created_at: cursor.value as Date, comment_id: { lt: cursor.id } }] } : {}),
        },
        orderBy: [{ created_at: 'desc' }, { comment_id: 'desc' }],
        take: query.limit + 1,
        include: {
            comment: {
                include: {
                    ...commentInclude,
                    post: { select: { community_id: true, short_id: true, slug: true, title: true, community: { select: { name: true } } } },
                },
            },
        },
    });
    const { items, next_cursor } = paginate(rows.map((row) => ({ ...row, id: row.comment_id })), query.limit, 'created_at');
    const { votes, saved } = await commentViewerState(user.id, items.map((row) => row.comment_id));
    response.json({
        comments: items.map((row) => ({
            ...toPublicComment(row.comment, row.comment.post.community_id, context, votes, saved),
            post: {
                short_id: row.comment.post.short_id,
                slug: row.comment.post.slug,
                title: row.comment.post.title,
                community: row.comment.post.community.name,
            },
        })),
        next_cursor,
    });
});

// Everything the account has written or chosen, as one JSON download (anonymous posts included: they're yours)
router.get('/me/export', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const [posts, comments, postVotes, commentVotes, savedPosts, savedComments, memberships, sessions] = await Promise.all([
        prisma.post.findMany({
            where: { author_id: user.id },
            orderBy: { created_at: 'asc' },
            select: {
                short_id: true, type: true, title: true, body: true, url: true, is_anonymous: true, status: true,
                created_at: true, edited_at: true, community: { select: { name: true } },
            },
        }),
        prisma.comment.findMany({
            where: { author_id: user.id },
            orderBy: { created_at: 'asc' },
            select: { short_id: true, body: true, is_anonymous: true, status: true, created_at: true, edited_at: true, post: { select: { short_id: true } } },
        }),
        prisma.postVote.findMany({ where: { user_id: user.id }, select: { value: true, created_at: true, post: { select: { short_id: true } } } }),
        prisma.commentVote.findMany({ where: { user_id: user.id }, select: { value: true, created_at: true, comment: { select: { short_id: true } } } }),
        prisma.savedPost.findMany({ where: { user_id: user.id }, select: { created_at: true, post: { select: { short_id: true } } } }),
        prisma.savedComment.findMany({ where: { user_id: user.id }, select: { created_at: true, comment: { select: { short_id: true } } } }),
        prisma.communityMember.findMany({ where: { user_id: user.id }, select: { role: true, joined_at: true, community: { select: { name: true } } } }),
        prisma.session.findMany({ where: { user_id: user.id }, select: { created_at: true, last_used_at: true, browser: true, os: true, country: true } }),
    ]);
    response.setHeader('Content-Disposition', `attachment; filename="${user.username}-data.json"`);
    response.json({
        exported_at: new Date(),
        account: toPrivateUser(user),
        posts,
        comments,
        votes: { posts: postVotes, comments: commentVotes },
        saved: { posts: savedPosts, comments: savedComments },
        communities: memberships,
        sessions,
    });
});

// Deletes the account: signs out everywhere, frees the email, and detaches the name from past content.
// Posts and comments stay so threads still make sense, but show no author.
router.delete('/me', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const { password } = parse(z.object({ password: z.string().max(256).optional() }), request.body);
    if (user.password_hash && !(await verifyPassword(password ?? '', user.password_hash))) {
        throw badRequest('Your password is wrong.', 'wrong_password');
    }
    await prisma.user.update({
        where: { id: user.id },
        data: {
            status: 'deleted',
            email: `deleted+${user.id}@invalid.local`,
            password_hash: null,
            google_id: null,
            display_name: null,
            notification_preferences: undefined,
        },
    });
    await revokeAllSessions(user.id);
    clearAuthCookies(response);
    response.json({ success: true });
});

// --- Public profiles ---

async function findPublicUser(username: string) {
    const user = await prisma.user.findUnique({ where: { username: username.toLowerCase() } });
    if (!user || user.status === 'deleted') throw notFound('User not found');
    return user;
}

router.get('/:username', async (request, response) => {
    const user = await findPublicUser(String(request.params.username));
    response.json({
        user: {
            // For reporting a user
            id: user.id,
            username: user.username,
            display_name: user.display_name,
            avatar_id: user.avatar_id,
            karma: user.karma,
            is_suspended: user.status !== 'active',
            created_at: user.created_at,
        },
    });
});

// Anonymous posts and posts in private communities never appear on a profile
router.get('/:username/posts', optionalAuth, async (request: AuthRequest, response) => {
    const query = parse(pageQuery, request.query);
    const user = await findPublicUser(String(request.params.username));
    const context = await viewerContext(request.viewer);
    response.json(
        await listPosts({
            where: { author_id: user.id, is_anonymous: false, community: { visibility: 'public' } },
            sort: 'new',
            cursor: query.cursor,
            limit: query.limit,
            context,
        })
    );
});

router.get('/:username/comments', optionalAuth, async (request: AuthRequest, response) => {
    const query = parse(pageQuery, request.query);
    const user = await findPublicUser(String(request.params.username));
    const context = await viewerContext(request.viewer);

    const rows = await prisma.comment.findMany({
        where: {
            AND: [
                {
                    author_id: user.id,
                    is_anonymous: false,
                    status: { in: ['active', 'locked'] },
                    ...notShadowHidden(context),
                    post: { ...READABLE_POST_WHERE, community: { visibility: 'public' } },
                },
                afterCursor('created_at', 'desc', decodeCursor(query.cursor)),
            ],
        },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        include: { ...commentInclude, post: { select: { community_id: true, short_id: true, slug: true, title: true, community: { select: { name: true } } } } },
    });
    const { items, next_cursor } = paginate(rows, query.limit, 'created_at');
    const { votes, saved } = await commentViewerState(context?.userId, items.map((row) => row.id));
    response.json({
        comments: items.map((row) => ({
            ...toPublicComment(row, row.post.community_id, context, votes, saved),
            post: { short_id: row.post.short_id, slug: row.post.slug, title: row.post.title, community: row.post.community.name },
        })),
        next_cursor,
    });
});

export default router;
