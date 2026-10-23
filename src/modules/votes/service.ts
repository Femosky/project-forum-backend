import { Prisma } from '@prisma/client';
import prisma from '../../prismaConnection';
import { hotRank, wilsonLowerBound } from '../../lib/ranking';
import { VoteMap } from '../../lib/serializers';

type Counts = { upvote_count: number; downvote_count: number };

// How a vote change moves the counters: e.g. switching from -1 to +1 is one more up and one fewer down
function delta(previous: number, next: number) {
    return {
        up: (next === 1 ? 1 : 0) - (previous === 1 ? 1 : 0),
        down: (next === -1 ? 1 : 0) - (previous === -1 ? 1 : 0),
    };
}

// Sets the viewer's vote on a post (1, -1, or 0 to clear) and updates counters, score, hot rank and the author's
// karma in one transaction. Locking the post row first serialises concurrent votes on the same post.
export async function votePost(postId: string, userId: string, value: number) {
    return prisma.$transaction(async (tx) => {
        const [post] = await tx.$queryRaw<(Counts & { created_at: Date; author_id: string })[]>`
            SELECT "upvote_count", "downvote_count", "created_at", "author_id" FROM "Post" WHERE "id" = ${postId}::uuid FOR UPDATE`;
        const existing = await tx.postVote.findUnique({ where: { user_id_post_id: { user_id: userId, post_id: postId } } });
        const previous = existing?.value ?? 0;
        if (previous === value) return { ...post, score: post.upvote_count - post.downvote_count, vote: value };

        if (value === 0) await tx.postVote.delete({ where: { user_id_post_id: { user_id: userId, post_id: postId } } });
        else if (existing) await tx.postVote.update({ where: { user_id_post_id: { user_id: userId, post_id: postId } }, data: { value } });
        else await tx.postVote.create({ data: { user_id: userId, post_id: postId, value } });

        const change = delta(previous, value);
        const upvote_count = post.upvote_count + change.up;
        const downvote_count = post.downvote_count + change.down;
        const score = upvote_count - downvote_count;
        await tx.post.update({
            where: { id: postId },
            data: { upvote_count, downvote_count, score, hot_rank: hotRank(score, post.created_at) },
        });
        if (post.author_id !== userId) {
            await tx.user.update({ where: { id: post.author_id }, data: { karma: { increment: change.up - change.down } } });
        }
        return { upvote_count, downvote_count, score, vote: value };
    });
}

export async function voteComment(commentId: string, userId: string, value: number) {
    return prisma.$transaction(async (tx) => {
        const [comment] = await tx.$queryRaw<(Counts & { author_id: string })[]>`
            SELECT "upvote_count", "downvote_count", "author_id" FROM "Comment" WHERE "id" = ${commentId}::uuid FOR UPDATE`;
        const where = { user_id_comment_id: { user_id: userId, comment_id: commentId } };
        const existing = await tx.commentVote.findUnique({ where });
        const previous = existing?.value ?? 0;
        if (previous === value) return { ...comment, score: comment.upvote_count - comment.downvote_count, vote: value };

        if (value === 0) await tx.commentVote.delete({ where });
        else if (existing) await tx.commentVote.update({ where, data: { value } });
        else await tx.commentVote.create({ data: { user_id: userId, comment_id: commentId, value } });

        const change = delta(previous, value);
        const upvote_count = comment.upvote_count + change.up;
        const downvote_count = comment.downvote_count + change.down;
        const score = upvote_count - downvote_count;
        await tx.comment.update({
            where: { id: commentId },
            data: { upvote_count, downvote_count, score, best_rank: wilsonLowerBound(upvote_count, downvote_count) },
        });
        if (comment.author_id !== userId) {
            await tx.user.update({ where: { id: comment.author_id }, data: { karma: { increment: change.up - change.down } } });
        }
        return { upvote_count, downvote_count, score, vote: value };
    });
}

// The viewer's votes and saves for a page of items, in two small queries
export async function postViewerState(userId: string | undefined, postIds: string[]) {
    if (!userId || postIds.length === 0) return { votes: new Map() as VoteMap, saved: new Set<string>() };
    const [votes, saves] = await Promise.all([
        prisma.postVote.findMany({ where: { user_id: userId, post_id: { in: postIds } }, select: { post_id: true, value: true } }),
        prisma.savedPost.findMany({ where: { user_id: userId, post_id: { in: postIds } }, select: { post_id: true } }),
    ]);
    return {
        votes: new Map(votes.map((vote) => [vote.post_id, vote.value])) as VoteMap,
        saved: new Set(saves.map((save) => save.post_id)),
    };
}

export async function commentViewerState(userId: string | undefined, commentIds: string[]) {
    if (!userId || commentIds.length === 0) return { votes: new Map() as VoteMap, saved: new Set<string>() };
    const [votes, saves] = await Promise.all([
        prisma.commentVote.findMany({
            where: { user_id: userId, comment_id: { in: commentIds } },
            select: { comment_id: true, value: true },
        }),
        prisma.savedComment.findMany({ where: { user_id: userId, comment_id: { in: commentIds } }, select: { comment_id: true } }),
    ]);
    return {
        votes: new Map(votes.map((vote) => [vote.comment_id, vote.value])) as VoteMap,
        saved: new Set(saves.map((save) => save.comment_id)),
    };
}

export const isUniqueViolation = (error: unknown) =>
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
