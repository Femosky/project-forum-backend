import { Router } from 'express';
import { track } from '../../lib/analytics';
import { z } from 'zod';
import prisma from '../../prismaConnection';
import { badRequest, forbidden, parse } from '../../lib/http';
import { DELETED_POST_DATA, LISTED_POST_STATUSES, postInclude, toPublicComment, toPublicPost } from '../../lib/serializers';
import { urlKey } from '../../lib/urls';
import { fetchLinkPreview } from '../../lib/linkPreview';
import { isTurnstileEnabled, requireTurnstile } from '../../lib/turnstile';
import { AuthRequest, optionalAuth, requireAuth, viewerOf } from '../../middlewares/auth';
import { assertCanParticipate, assertCanPost, findCommunity, viewerContext } from '../communities/access';
import { reviewContent } from '../safety/review';
import { assertAnonymousAllowed, assertLinksAllowed, assertWithinYoungAccountLimits, canPostLinks } from '../safety/policy';
import { assertCommentable, createComment, listPostComments } from '../comments/service';
import { notifyForComment } from '../notifications/service';
import { postViewerState, votePost } from '../votes/service';
import { commentsQuery, createCommentSchema, createPostSchema, updatePostSchema, voteSchema } from './schema';
import { createPost, findVisiblePost, relatedPosts, serializePosts } from './service';
import { indexNowJob, postPath } from '../seo/jobs';
import { isBot } from '../../lib/bots';
import { recordPostView } from '../metrics/buffer';

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
    const image = input.type === 'image' ? input.image : undefined;
    assertAnonymousAllowed(user, input.is_anonymous);
    assertLinksAllowed(user, [input.title, input.body], url);
    await assertWithinYoungAccountLimits(user, 'post');
    if (input.flair_id && !(await prisma.flair.findFirst({ where: { id: input.flair_id, community_id: community.id } }))) {
        throw badRequest('That flair is not part of this community.', 'invalid_flair');
    }

    if (image && !canPostLinks(user)) throw forbidden("New accounts can't post pictures yet. You can once your account is a day old.", 'new_account_pictures');
    // The picture was checked when it was uploaded; the post (words and picture together) is checked again here
    const review = await reviewContent({ user, kind: 'post', title: input.title, body: input.body, url, imageUrls: image ? [image.url] : [], communityId: community.id });
    const post = await createPost({
        communityId: community.id,
        authorId: user.id,
        type: input.type,
        title: input.title,
        body: input.body,
        url,
        image,
        is_anonymous: input.is_anonymous,
        // The automatic check adds the mature label to graphic posts the author didn't mark
        is_nsfw: input.is_nsfw || community.is_nsfw || review.mature,
        flair_id: input.flair_id,
        held_reason: review.held_reason,
        held_for_admins: review.held_for_admins,
        shadow_hidden: user.shadow_banned_at !== null,
    });

    const context = await viewerContext(request.viewer);
    const created = toPublicPost(post, context);
    if (created.is_indexable) await indexNowJob.enqueue({ paths: [postPath(post)] });
    // Anonymous posts are counted without their community, so the event can't be matched to the post
    track('post_created', user.id, {
        type: input.type,
        anonymous: input.is_anonymous,
        community: input.is_anonymous ? undefined : community.name,
        held: post.status === 'pending',
    });
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

// A person opened this post's page. Counts one view for the post and one for each comment that was on screen (sent
// by the page, at most 100). Bots and the author's own visits don't count. Counts are shown to authors only. Views
// are buffered in memory and written in batches (modules/metrics/buffer.ts), so a page view costs no write.
const viewSchema = z.object({ comment_ids: z.array(z.uuid()).max(100).default([]) });

router.post('/:id/view', optionalAuth, async (request: AuthRequest, response) => {
    const { comment_ids } = parse(viewSchema, request.body ?? {});
    if (isBot(request.get('user-agent'))) {
        response.status(204).end();
        return;
    }
    const context = await viewerContext(request.viewer);
    const post = await findVisiblePost(String(request.params.id), request.viewer?.user, context);
    recordPostView(post, [...new Set(comment_ids.map((id) => id.toLowerCase()))], request.viewer?.user.id ?? null);
    response.status(204).end();
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
    let review: Awaited<ReturnType<typeof reviewContent>> = { held_reason: null, held_for_admins: false, mature: false };
    if (bodyChanged) {
        assertLinksAllowed(user, [input.body!]);
        if (post.status === 'active') {
            review = await reviewContent({ user, kind: 'post', title: post.title, body: input.body!, communityId: post.community_id });
        }
    }
    const heldReason = review.held_reason;

    const [updated] = await prisma.$transaction([
        prisma.post.update({
            where: { id: post.id },
            data: {
                ...(bodyChanged ? { body: input.body, edited_at: new Date() } : {}),
                ...(input.is_nsfw !== undefined ? { is_nsfw: input.is_nsfw } : {}),
                ...(review.mature ? { is_nsfw: true } : {}),
                ...(input.flair_id !== undefined ? { flair_id: input.flair_id } : {}),
                ...(heldReason ? { status: 'pending' as const, held_reason: heldReason, held_for_admins: review.held_for_admins, pinned_at: null } : {}),
            },
            include: postInclude,
        }),
        ...(heldReason && !post.shadow_hidden
            ? [prisma.community.update({ where: { id: post.community_id }, data: { post_count: { decrement: 1 } } })]
            : []),
    ]);
    response.json({ post: toPublicPost(updated, context) });
});

// The author deletes their post: it leaves every list and its text, link and author are wiped, but the page stays
// up as a "[deleted]" tombstone while comments remain under it, so other people's replies aren't lost
router.delete('/:id', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const context = await viewerContext(request.viewer);
    const post = await findVisiblePost(String(request.params.id), user, context);
    if (post.author_id !== user.id) throw forbidden('You can only delete your own posts.', 'not_author');
    if (post.status === 'deleted') return response.json({ success: true });

    const wasCounted = (post.status === 'active' || post.status === 'locked') && !post.shadow_hidden;
    await prisma.$transaction([
        prisma.post.update({ where: { id: post.id }, data: DELETED_POST_DATA }),
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

    track('vote', user.id, { target: 'post', value });
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

    const review = await reviewContent({ user, kind: 'comment', body: input.body, postId: post.id });
    const comment = await createComment({
        postId: post.id,
        authorId: user.id,
        body: input.body,
        parentId: input.parent_id,
        isAnonymous: input.is_anonymous,
        heldReason: review.held_reason,
        heldForAdmins: review.held_for_admins,
        shadowHidden: user.shadow_banned_at !== null,
    });
    track('comment_created', user.id, { reply: Boolean(input.parent_id), anonymous: input.is_anonymous, held: comment.status === 'pending' });
    // Nobody hears about a comment that isn't visible yet
    if (comment.status === 'active' && !comment.shadow_hidden) await notifyForComment(comment);
    response.status(201).json({ comment: { ...toPublicComment(comment, post.community_id, context), replies: [], more_replies: 0 } });
});

export default router;
