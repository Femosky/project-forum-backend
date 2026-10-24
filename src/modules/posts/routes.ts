import { Router } from 'express';
import { z } from 'zod';
import prisma from '../../prismaConnection';
import { badRequest, forbidden, parse } from '../../lib/http';
import { LISTED_POST_STATUSES, postInclude, toPublicComment, toPublicPost } from '../../lib/serializers';
import { urlKey } from '../../lib/urls';
import { fetchLinkPreview } from '../../lib/linkPreview';
import { isTurnstileEnabled, requireTurnstile } from '../../lib/turnstile';
import { AuthRequest, optionalAuth, requireAuth, viewerOf } from '../../middlewares/auth';
import { assertCanParticipate, assertCanPost, findCommunity, viewerContext } from '../communities/access';
import { screenContent } from '../safety/filters';
import { assertAnonymousAllowed, assertLinksAllowed, assertWithinYoungAccountLimits } from '../safety/policy';
import { assertCommentable, createComment, listPostComments } from '../comments/service';
import { notifyForComment } from '../notifications/service';
import { postViewerState, votePost } from '../votes/service';
import { commentsQuery, createCommentSchema, createPostSchema, updatePostSchema, voteSchema } from './schema';
import { createPost, findVisiblePost, relatedPosts, serializePosts } from './service';
import { indexNowJob, postPath } from '../seo/jobs';

const router = Router();

// Accounts younger than this must pass Turnstile to post (when Turnstile is configured)
const NEW_ACCOUNT_MS = 24 * 60 * 60 * 1000;

router.post('/', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const input = parse(createPostSchema, request.body);

    if (isTurnstileEnabled() && Date.now() - user.created_at.getTime() < NEW_ACCOUNT_MS) {
        await requireTurnstile(input.turnstile_token, request.ip);
    }

    const community = await findCommunity(input.community);
    await assertCanPost(community, user);
    const url = input.type === 'link' ? input.url : undefined;
    assertAnonymousAllowed(user, input.is_anonymous);
    assertLinksAllowed(user, [input.title, input.body], url);
    await assertWithinYoungAccountLimits(user, 'post');
    if (input.flair_id && !(await prisma.flair.findFirst({ where: { id: input.flair_id, community_id: community.id } }))) {
        throw badRequest('That flair is not part of this community.', 'invalid_flair');
    }

    const post = await createPost({
        communityId: community.id,
        authorId: user.id,
        type: input.type,
        title: input.title,
        body: input.body,
        url,
        is_anonymous: input.is_anonymous,
        is_nsfw: input.is_nsfw || community.is_nsfw,
        flair_id: input.flair_id,
        held_reason: await screenContent({ user, kind: 'post', title: input.title, body: input.body, url, communityId: community.id }),
        shadow_hidden: user.shadow_banned_at !== null,
    });

    const context = await viewerContext(request.viewer);
    const created = toPublicPost(post, context);
    if (created.is_indexable) await indexNowJob.enqueue({ paths: [postPath(post)] });
    response.status(201).json({ post: created });
});

const linkQuery = z.object({ url: z.string().trim().min(1).max(2048) });

// Earlier posts of the same link in public communities, so the composer can say "this was already posted in..."
router.get('/duplicates', optionalAuth, async (request: AuthRequest, response) => {
    const { url } = parse(linkQuery, request.query);
    const key = urlKey(url);
    if (!key) return response.json({ posts: [] });
    const rows = await prisma.post.findMany({
        where: { url_key: key, status: { in: LISTED_POST_STATUSES }, shadow_hidden: false, community: { visibility: 'public', status: 'active' } },
        orderBy: { created_at: 'desc' },
        take: 5,
        include: postInclude,
    });
    response.json({ posts: await serializePosts(rows, await viewerContext(request.viewer)) });
});

// A preview card for a link while composing (signed in only, so this isn't a free fetch-anything proxy).
// The fetcher refuses private addresses, caps size and time, and an unreachable page is just no preview.
router.get('/link-preview', requireAuth, async (request: AuthRequest, response) => {
    const { url } = parse(linkQuery, request.query);
    if (!urlKey(url)) throw badRequest('Enter a full link, starting with https://', 'invalid_url');
    const preview = await fetchLinkPreview(url).catch(() => null);
    response.json({ preview });
});

router.get('/:id', optionalAuth, async (request: AuthRequest, response) => {
    const context = await viewerContext(request.viewer);
    const post = await findVisiblePost(String(request.params.id), request.viewer?.user, context);
    const { votes, saved } = await postViewerState(context?.userId, [post.id]);
    response.json({ post: toPublicPost(post, context, votes, saved) });
});

// Internal links for the post page: "Related threads" (full-text match on this post's title, any public community)
// and "More from this community" (its top posts this month). Light rows only, since the page shows just titles.
router.get('/:id/related', optionalAuth, async (request: AuthRequest, response) => {
    const context = await viewerContext(request.viewer);
    const post = await findVisiblePost(String(request.params.id), request.viewer?.user, context);
    response.json(await relatedPosts(post));
});

router.patch('/:id', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const context = await viewerContext(request.viewer);
    const post = await findVisiblePost(String(request.params.id), user, context);
    if (post.author_id !== user.id) throw forbidden('You can only edit your own posts.', 'not_author');
    if (post.status === 'removed' || post.status === 'deleted') throw badRequest("This post can't be edited.", 'post_unavailable');

    const input = parse(updatePostSchema, request.body);
    if (input.flair_id && !(await prisma.flair.findFirst({ where: { id: input.flair_id, community_id: post.community_id } }))) {
        throw badRequest('That flair is not part of this community.', 'invalid_flair');
    }

    // An edit goes through the same checks as a new post, so a clean post can't be edited into a scam
    const bodyChanged = input.body !== undefined && input.body !== post.body;
    let heldReason: string | null = null;
    if (bodyChanged) {
        assertLinksAllowed(user, [input.body!]);
        if (post.status === 'active') {
            heldReason = await screenContent({ user, kind: 'post', body: input.body!, communityId: post.community_id });
        }
    }

    const [updated] = await prisma.$transaction([
        prisma.post.update({
            where: { id: post.id },
            data: {
                ...(bodyChanged ? { body: input.body, edited_at: new Date() } : {}),
                ...(input.is_nsfw !== undefined ? { is_nsfw: input.is_nsfw } : {}),
                ...(input.flair_id !== undefined ? { flair_id: input.flair_id } : {}),
                ...(heldReason ? { status: 'pending' as const, held_reason: heldReason, pinned_at: null } : {}),
            },
            include: postInclude,
        }),
        ...(heldReason && !post.shadow_hidden
            ? [prisma.community.update({ where: { id: post.community_id }, data: { post_count: { decrement: 1 } } })]
            : []),
    ]);
    response.json({ post: toPublicPost(updated, context) });
});

// The author deletes their post: it leaves every list, but its comments stay readable to moderators
router.delete('/:id', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const context = await viewerContext(request.viewer);
    const post = await findVisiblePost(String(request.params.id), user, context);
    if (post.author_id !== user.id) throw forbidden('You can only delete your own posts.', 'not_author');
    if (post.status === 'deleted') return response.json({ success: true });

    const wasCounted = (post.status === 'active' || post.status === 'locked') && !post.shadow_hidden;
    await prisma.$transaction([
        prisma.post.update({ where: { id: post.id }, data: { status: 'deleted', pinned_at: null } }),
        ...(wasCounted
            ? [prisma.community.update({ where: { id: post.community_id }, data: { post_count: { decrement: 1 } } })]
            : []),
    ]);
    response.json({ success: true });
});

// One endpoint for every vote change: 1 up, -1 down, 0 clears
router.put('/:id/vote', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const { value } = parse(voteSchema, request.body);
    const context = await viewerContext(request.viewer);
    const post = await findVisiblePost(String(request.params.id), user, context);
    if (post.status !== 'active' && post.status !== 'locked') throw badRequest("You can't vote on this post.", 'post_unavailable');
    await assertCanParticipate(post.community, user);

    response.json(await votePost(post.id, user.id, value));
});

router.put('/:id/save', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const post = await findVisiblePost(String(request.params.id), user, await viewerContext(request.viewer));
    await prisma.savedPost.upsert({
        where: { user_id_post_id: { user_id: user.id, post_id: post.id } },
        create: { user_id: user.id, post_id: post.id },
        update: {},
    });
    response.json({ saved: true });
});

router.delete('/:id/save', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const post = await findVisiblePost(String(request.params.id), user, await viewerContext(request.viewer));
    await prisma.savedPost.deleteMany({ where: { user_id: user.id, post_id: post.id } });
    response.json({ saved: false });
});

router.get('/:id/comments', optionalAuth, async (request: AuthRequest, response) => {
    const query = parse(commentsQuery, request.query);
    const context = await viewerContext(request.viewer);
    const post = await findVisiblePost(String(request.params.id), request.viewer?.user, context);

    response.json(
        await listPostComments({
            postId: post.id,
            communityId: post.community_id,
            sort: query.sort,
            cursor: query.cursor,
            limit: query.limit,
            depth: query.depth,
            replies: query.replies,
            context,
        })
    );
});

router.post('/:id/comments', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const input = parse(createCommentSchema, request.body);
    const context = await viewerContext(request.viewer);
    const post = await findVisiblePost(String(request.params.id), user, context);
    assertCommentable(post);
    await assertCanPost(post.community, user);
    assertAnonymousAllowed(user, input.is_anonymous);
    assertLinksAllowed(user, [input.body]);
    await assertWithinYoungAccountLimits(user, 'comment');

    const comment = await createComment({
        postId: post.id,
        authorId: user.id,
        body: input.body,
        parentId: input.parent_id,
        isAnonymous: input.is_anonymous,
        heldReason: await screenContent({ user, kind: 'comment', body: input.body, postId: post.id }),
        shadowHidden: user.shadow_banned_at !== null,
    });
    // Nobody hears about a comment that isn't visible yet
    if (comment.status === 'active' && !comment.shadow_hidden) await notifyForComment(comment);
    response.status(201).json({ comment: { ...toPublicComment(comment, post.community_id, context), replies: [], more_replies: 0 } });
});

export default router;
