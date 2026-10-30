import { Router } from 'express';
import { alertModerators } from '../moderation/alerts';
import { track } from '../../lib/analytics';
import { Prisma, User } from '@prisma/client';
import prisma from '../../prismaConnection';
import { badRequest, forbidden, notFound, parse } from '../../lib/http';
import { idOrShortId } from '../../lib/ids';
import { commentInclude, isHiddenFrom, isReadablePost, THREAD_COMMENT_STATUSES, toPublicComment } from '../../lib/serializers';
import { AuthRequest, optionalAuth, requireAuth, viewerOf } from '../../middlewares/auth';
import { assertCanParticipate, assertCanView, canModerate, viewerContext, ViewerContext } from '../communities/access';
import { commentViewerState, voteComment } from '../votes/service';
import { repliesQuery, updateCommentSchema, voteSchema } from './schema';
import { listReplies, setCommentStatus } from './service';
import { reviewContent } from '../safety/review';
import { assertLinksAllowed } from '../safety/policy';

const router = Router();

// A comment this viewer may see, with its post and community
export async function findVisibleComment(idOrShort: string, user: User | undefined, context: ViewerContext) {
    const comment = await prisma.comment.findUnique({
        where: idOrShortId(idOrShort) as Prisma.CommentWhereUniqueInput,
        include: { ...commentInclude, post: { include: { community: true } } },
    });
    if (!comment) throw notFound('Comment not found');

    const { post } = comment;
    const isMod = canModerate(context, post.community_id);
    const postVisible = isReadablePost(post) || isMod;
    const commentVisible =
        THREAD_COMMENT_STATUSES.includes(comment.status) || isMod || context?.userId === comment.author_id;
    if (!postVisible || !commentVisible || isHiddenFrom(comment, context) || isHiddenFrom(post, context) || post.community.status === 'deleted') {
        throw notFound('Comment not found');
    }

    await assertCanView(post.community, user);
    return comment;
}

router.get('/:id', optionalAuth, async (request: AuthRequest, response) => {
    const context = await viewerContext(request.viewer);
    const comment = await findVisibleComment(String(request.params.id), request.viewer?.user, context);
    const { votes, saved } = await commentViewerState(context?.userId, [comment.id]);
    response.json({
        comment: toPublicComment(comment, comment.post.community_id, context, votes, saved),
        post: { id: comment.post.id, short_id: comment.post.short_id, slug: comment.post.slug, title: comment.post.title },
        community: { name: comment.post.community.name },
    });
});

// Loads more replies under a comment, or continues a thread that went past the visible depth
router.get('/:id/replies', optionalAuth, async (request: AuthRequest, response) => {
    const query = parse(repliesQuery, request.query);
    const context = await viewerContext(request.viewer);
    const comment = await findVisibleComment(String(request.params.id), request.viewer?.user, context);
    response.json(await listReplies(comment.id, comment.post.community_id, { ...query, context }));
});

router.patch('/:id', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const { body } = parse(updateCommentSchema, request.body);
    const context = await viewerContext(request.viewer);
    const comment = await findVisibleComment(String(request.params.id), user, context);
    if (comment.author_id !== user.id) throw forbidden('You can only edit your own comments.', 'not_author');
    if (comment.status === 'deleted' || comment.status === 'removed') {
        throw badRequest("This comment can't be edited.", 'comment_unavailable');
    }

    // Edits go through the same checks as new comments
    assertLinksAllowed(user, [body]);
    const review = comment.status === 'active' ? await reviewContent({ user, kind: 'comment', body, postId: comment.post_id }) : null;
    const heldReason = review?.held_reason ?? null;

    const updated = heldReason
        ? await setCommentStatus(comment, 'pending', { body, edited_at: new Date(), held_reason: heldReason, held_for_admins: review!.held_for_admins, pinned_at: null })
        : await prisma.comment.update({ where: { id: comment.id }, data: { body, edited_at: new Date() }, include: commentInclude });
    if (heldReason && !review!.held_for_admins) alertModerators(comment.post.community_id, 'mod_queue');
    response.json({ comment: toPublicComment(updated, comment.post.community_id, context) });
});

// The author deletes their comment. The text is wiped; the row stays so replies keep their place.
router.delete('/:id', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const context = await viewerContext(request.viewer);
    const comment = await findVisibleComment(String(request.params.id), user, context);
    if (comment.author_id !== user.id) throw forbidden('You can only delete your own comments.', 'not_author');
    if (comment.status !== 'deleted') {
        await setCommentStatus(comment, 'deleted', { body: '', pinned_at: null });
    }
    response.json({ success: true });
});

router.put('/:id/vote', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const { value } = parse(voteSchema, request.body);
    const context = await viewerContext(request.viewer);
    const comment = await findVisibleComment(String(request.params.id), user, context);
    if (comment.status !== 'active' && comment.status !== 'locked') {
        throw badRequest("You can't vote on this comment.", 'comment_unavailable');
    }
    await assertCanParticipate(comment.post.community, user);
    track('vote', user.id, { target: 'comment', value });
    response.json(await voteComment(comment.id, user.id, value));
});

router.put('/:id/save', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const comment = await findVisibleComment(String(request.params.id), user, await viewerContext(request.viewer));
    await prisma.savedComment.upsert({
        where: { user_id_comment_id: { user_id: user.id, comment_id: comment.id } },
        create: { user_id: user.id, comment_id: comment.id },
        update: {},
    });
    response.json({ saved: true });
});

router.delete('/:id/save', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const comment = await findVisibleComment(String(request.params.id), user, await viewerContext(request.viewer));
    await prisma.savedComment.deleteMany({ where: { user_id: user.id, comment_id: comment.id } });
    response.json({ saved: false });
});

export default router;
