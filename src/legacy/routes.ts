import { Router } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../prismaConnection';
import { badRequest, notFound, parse } from '../lib/http';
import { commentInclude, LISTED_POST_STATUSES, postInclude, THREAD_COMMENT_STATUSES } from '../lib/serializers';
import { toPublicComment, toPublicPost, PublicComment, PublicPost } from '../lib/serializers';
import { AuthRequest, optionalAuth, requireAuth, viewerOf } from '../middlewares/auth';
import { login, logout, refresh } from '../modules/auth/routes';
import { parseRefreshToken, REFRESH_COOKIE } from '../modules/auth/tokens';
import { assertCanParticipate, assertCanView, findCommunity, viewerContext, ViewerContext } from '../modules/communities/access';
import { assertCommentable, createComment } from '../modules/comments/service';
import { findVisiblePost } from '../modules/posts/service';
import { createCommentSchema } from '../modules/posts/schema';
import { z } from 'zod';

// DEPRECATED: the pre-v1 endpoints the current web app still calls, rebuilt on the v2 schema with their old
// response shapes. Delete this file once the web app moves to /v1 (Phase 3).

const router = Router();

type Pagination = {
    current_page: number;
    total_pages: number;
    total_items: number;
    has_next_page: boolean;
    has_previous_page: boolean;
    next_page: number | null;
    previous_page: number | null;
};

function pagination(page: number, limit: number, total: number): Pagination {
    const totalPages = Math.ceil(total / limit);
    return {
        current_page: page,
        total_pages: totalPages,
        total_items: total,
        has_next_page: page < totalPages,
        has_previous_page: page > 1,
        next_page: page < totalPages ? page + 1 : null,
        previous_page: page > 1 ? page - 1 : null,
    };
}

function pageParams(page: unknown, limit: unknown, defaultLimit: number) {
    const pageNumber = Math.max(1, parseInt(String(page)) || 1);
    const limitNumber = Math.min(Math.max(1, parseInt(String(limit)) || defaultLimit), 100);
    return { page: pageNumber, limit: limitNumber, skip: (pageNumber - 1) * limitNumber };
}

function legacyOrder(sortBy: unknown): Prisma.PostOrderByWithRelationInput[] {
    if (sortBy === 'newest') return [{ created_at: 'desc' }, { id: 'desc' }];
    if (sortBy === 'oldest') return [{ created_at: 'asc' }, { id: 'asc' }];
    if (sortBy === 'most_commented') return [{ comment_count: 'desc' }, { id: 'desc' }];
    return [{ score: 'desc' }, { created_at: 'desc' }];
}

function legacyCommentOrder(sortBy: unknown): Prisma.CommentOrderByWithRelationInput[] {
    if (sortBy === 'newest') return [{ created_at: 'desc' }, { id: 'desc' }];
    if (sortBy === 'oldest') return [{ created_at: 'asc' }, { id: 'asc' }];
    if (sortBy === 'most_commented') return [{ reply_count: 'desc' }, { id: 'desc' }];
    return [{ score: 'desc' }, { created_at: 'desc' }];
}

const legacyAuthor = (author: { username: string; avatar_id: string } | null) =>
    author ? { username: author.username, avatar_id: author.avatar_id } : null;

function toLegacyPost(post: PublicPost, authorId: string | null) {
    return {
        id: post.id,
        short_id: post.short_id,
        slug: post.slug,
        title: post.title,
        content: post.body,
        ai_summary: post.ai_summary,
        created_at: post.created_at,
        is_anonymous: post.is_anonymous,
        is_edited: post.edited_at !== null,
        edited_at: post.edited_at,
        status: post.status,
        community_id: post.community.id,
        author_id: post.author ? authorId : null,
        author_ref: legacyAuthor(post.author),
        community_ref: { name: post.community.name },
        _count: { comments: post.comment_count, upvoters: post.upvote_count, downvoters: post.downvote_count },
    };
}

type LegacyComment = {
    id: string;
    short_id: string;
    post_id: string;
    parent_comment_id: string | null;
    content: string;
    created_at: Date;
    is_edited: boolean;
    edited_at: Date | null;
    is_anonymous: boolean;
    status: string;
    author_id: string | null;
    author_ref: { username: string; avatar_id: string } | null;
    child_comments?: LegacyComment[];
    _count: { child_comments: number; upvoters: number; downvoters: number };
};

function toLegacyComment(comment: PublicComment, authorId: string | null, children?: LegacyComment[]): LegacyComment {
    return {
        id: comment.id,
        short_id: comment.short_id,
        post_id: comment.post_id,
        parent_comment_id: comment.parent_id,
        content: comment.body,
        created_at: comment.created_at,
        is_edited: comment.edited_at !== null,
        edited_at: comment.edited_at,
        is_anonymous: comment.is_anonymous,
        status: comment.status,
        author_id: comment.author ? authorId : null,
        author_ref: legacyAuthor(comment.author),
        ...(children ? { child_comments: children } : {}),
        _count: { child_comments: comment.reply_count, upvoters: comment.upvote_count, downvoters: comment.downvote_count },
    };
}

type CommentWithAuthor = Prisma.CommentGetPayload<{ include: typeof commentInclude }>;

const legacyComment = (row: CommentWithAuthor, communityId: string, context: ViewerContext, children?: LegacyComment[]) =>
    toLegacyComment(toPublicComment(row, communityId, context), row.author_id, children);

// --- Auth ---

router.post('/auth/login', login);
router.get('/auth/logout', logout);
router.get('/auth/refresh-token', refresh);

router.get('/auth/is-authenticated', async (request, response) => {
    const parsed = parseRefreshToken(request.cookies?.[REFRESH_COOKIE]);
    const session = parsed
        ? await prisma.session.findUnique({ where: { id: parsed.sessionId } }).catch(() => null)
        : null;
    if (!session || session.revoked_at || session.expires_at <= new Date()) {
        return response.status(400).json({ error: 'User is not authenticated.' });
    }
    response.json({ message: 'User already logged in.' });
});

// --- Communities ---

router.get('/community/get/communities', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const rows = await prisma.communityMember.findMany({
        where: { user_id: user.id, is_banned: false, community: { status: { not: 'deleted' } } },
        orderBy: { joined_at: 'desc' },
        select: { community: { select: { id: true, name: true, image_url: true, description: true } } },
    });
    response.json({ communities: rows.map((row) => row.community) });
});

router.get('/community/:community_name', async (request, response) => {
    const community = await findCommunity(String(request.params.community_name));
    response.json({
        community: {
            id: community.id,
            name: community.name,
            description: community.description,
            image_url: community.image_url,
            status: community.status,
            created_at: community.created_at,
            _count: { members: community.member_count, posts: community.post_count },
        },
    });
});

// The web app's home page asks for a community called "hi" (names are now 3+ characters, so it can't exist).
// Until Phase 3 points the home page at /v1/feed, that name returns posts from every public community.
const LEGACY_HOME_COMMUNITY = 'hi';

router.get('/community/:community_name/posts', optionalAuth, async (request: AuthRequest, response) => {
    const name = String(request.params.community_name).toLowerCase();
    const isLegacyHome = name === LEGACY_HOME_COMMUNITY;
    const community = isLegacyHome ? null : await findCommunity(name);
    if (community) await assertCanView(community, request.viewer?.user);
    const context = await viewerContext(request.viewer);
    const { page, limit, skip } = pageParams(request.query.page, request.query.limit, 10);
    const where: Prisma.PostWhereInput = {
        ...(community ? { community_id: community.id } : { community: { visibility: 'public', status: 'active' } }),
        status: { in: LISTED_POST_STATUSES },
    };

    const [rows, total] = await Promise.all([
        prisma.post.findMany({ where, orderBy: legacyOrder(request.query.sort_by), skip, take: limit, include: postInclude }),
        prisma.post.count({ where }),
    ]);
    response.json({
        posts: rows.map((row) => toLegacyPost(toPublicPost(row, context), row.author_id)),
        pagination: pagination(page, limit, total),
    });
});

// Post page: the post, its top-level comments, and the first two replies under each
router.get('/community/:community_name/replies/:post_short_id', optionalAuth, async (request: AuthRequest, response) => {
    const context = await viewerContext(request.viewer);
    const post = await findVisiblePost(String(request.params.post_short_id), request.viewer?.user, context).catch(() => {
        throw notFound('Post not found');
    });
    const { page, limit, skip } = pageParams(request.query.parent_page_number, request.query.parent_limit, 10);
    const childLimit = pageParams(1, request.query.child_limit, 2).limit;
    const where = { post_id: post.id, depth: 0, status: { in: THREAD_COMMENT_STATUSES } };

    const [rows, total] = await Promise.all([
        prisma.comment.findMany({
            where,
            orderBy: legacyCommentOrder(request.query.sort_by),
            skip,
            take: limit,
            include: {
                ...commentInclude,
                replies: {
                    where: { status: { in: THREAD_COMMENT_STATUSES } },
                    orderBy: [{ score: 'desc' }, { created_at: 'desc' }],
                    take: childLimit,
                    include: commentInclude,
                },
            },
        }),
        prisma.comment.count({ where }),
    ]);

    response.json({
        post: toLegacyPost(toPublicPost(post, context), post.author_id),
        comments: rows.map((row) =>
            legacyComment(
                row,
                post.community_id,
                context,
                row.replies.map((child) => legacyComment(child, post.community_id, context))
            )
        ),
        pagination: pagination(page, limit, total),
    });
});

router.get(
    '/community/:community_name/replies/:post_short_id/reply/:comment_short_id',
    optionalAuth,
    async (request: AuthRequest, response) => {
        const context = await viewerContext(request.viewer);
        const parent = await prisma.comment.findUnique({
            where: { short_id: String(request.params.comment_short_id).toLowerCase() },
            include: { post: { select: { short_id: true } } },
        });
        if (!parent || parent.post.short_id !== String(request.params.post_short_id).toLowerCase()) {
            throw notFound('Parent comment not found');
        }
        const post = await findVisiblePost(parent.post_id, request.viewer?.user, context).catch(() => {
            throw notFound('Parent comment not found');
        });
        if (!THREAD_COMMENT_STATUSES.includes(parent.status)) throw notFound('Parent comment not found');

        const { page, limit, skip } = pageParams(request.query.parent_page_number, request.query.parent_limit, 10);
        const where = { parent_id: parent.id, status: { in: THREAD_COMMENT_STATUSES } };
        const [rows, total] = await Promise.all([
            prisma.comment.findMany({ where, orderBy: legacyCommentOrder(request.query.sort_by), skip, take: limit, include: commentInclude }),
            prisma.comment.count({ where }),
        ]);
        response.json({
            comments: rows.map((row) => legacyComment(row, post.community_id, context)),
            pagination: pagination(page, limit, total),
        });
    }
);

// --- Comments ---

const legacyCreateComment = z.object({
    post_id: z.uuid({ error: 'Post ID is required' }),
    content: z.string(),
    is_anonymous: z.boolean().optional(),
    parent_comment_id: z.uuid().optional().nullable(),
});

router.post('/comment/create', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const legacy = parse(legacyCreateComment, request.body);
    const input = parse(createCommentSchema, {
        body: legacy.content,
        parent_id: legacy.parent_comment_id ?? undefined,
        is_anonymous: legacy.is_anonymous ?? false,
    });
    const context = await viewerContext(request.viewer);
    const post = await findVisiblePost(legacy.post_id, user, context).catch(() => {
        throw badRequest('Post not found');
    });
    assertCommentable(post);
    await assertCanParticipate(post.community, user);

    const comment = await createComment({
        postId: post.id,
        authorId: user.id,
        body: input.body,
        parentId: input.parent_id,
        isAnonymous: input.is_anonymous,
    });
    response.json({ message: 'Comment created successfully', comment: legacyComment(comment, post.community_id, context, []) });
});

export default router;
