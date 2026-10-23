import { Prisma } from '@prisma/client';
import prisma from '../../prismaConnection';
import { afterCursor, decodeCursor, paginate } from '../../lib/cursor';
import { badRequest, forbidden, HttpError } from '../../lib/http';
import { withShortIdRetry } from '../../lib/ids';
import {
    commentInclude,
    CommentRow,
    PublicComment,
    THREAD_COMMENT_STATUSES,
    toPublicComment,
} from '../../lib/serializers';
import { ViewerContext } from '../communities/access';
import { commentViewerState } from '../votes/service';

export type CommentSort = 'best' | 'top' | 'new' | 'old';

// Deepest a reply can nest. The web app shows ~8 levels and links to "continue thread" below that.
export const MAX_COMMENT_DEPTH = 50;

const SORTS = {
    best: { field: 'best_rank', direction: 'desc' },
    top: { field: 'score', direction: 'desc' },
    new: { field: 'created_at', direction: 'desc' },
    old: { field: 'created_at', direction: 'asc' },
} as const;

// ORDER BY for raw SQL; field and direction come from the fixed table above, never from input
const orderSql = (sort: CommentSort, alias: string) => {
    const { field, direction } = SORTS[sort];
    return Prisma.raw(`${alias}."${field}" ${direction}, ${alias}."id" ${direction}`);
};

type ParentRef = { id: string; root_id: string | null; path: string; depth: number };

type RawComment = Omit<CommentRow, 'author'> & {
    author_username: string | null;
    author_display_name: string | null;
    author_avatar_id: string | null;
    author_status: string | null;
};

// Descendants of the given comments, up to `levels` deep and `perParent` replies under each comment, in one query.
// Uses root_id + the materialised path to stay inside the right subtrees and a window function to cap fan-out.
async function loadDescendants(parents: ParentRef[], levels: number, perParent: number, sort: CommentSort) {
    if (parents.length === 0 || levels <= 0 || perParent <= 0) return [];

    const rootIds = [...new Set(parents.map((parent) => parent.root_id ?? parent.id))];
    const patterns = parents.map((parent) => `${parent.path}/%`);
    const maxDepth = Math.max(...parents.map((parent) => parent.depth)) + levels;

    const rows = await prisma.$queryRaw<RawComment[]>`
        SELECT * FROM (
            SELECT c."id", c."short_id", c."post_id", c."author_id", c."parent_id", c."root_id", c."depth", c."path",
                   c."body", c."is_anonymous", c."is_sponsored", c."status", c."created_at", c."edited_at", c."pinned_at",
                   c."upvote_count", c."downvote_count", c."score", c."reply_count", c."best_rank",
                   u."username" AS "author_username", u."display_name" AS "author_display_name",
                   u."avatar_id" AS "author_avatar_id", u."status"::text AS "author_status",
                   row_number() OVER (PARTITION BY c."parent_id" ORDER BY ${orderSql(sort, 'c')}) AS "rank"
            FROM "Comment" c
            LEFT JOIN "User" u ON u."id" = c."author_id"
            WHERE c."root_id" = ANY(${rootIds}::uuid[])
              AND c."path" LIKE ANY(${patterns}::text[])
              AND c."depth" <= ${maxDepth}
              AND c."status"::text = ANY(${THREAD_COMMENT_STATUSES}::text[])
        ) t
        WHERE t."rank" <= ${perParent}
        ORDER BY t."depth", ${orderSql(sort, 't')}`;

    return rows.map(({ author_username, author_display_name, author_avatar_id, author_status, ...row }) => {
        delete (row as { rank?: unknown }).rank;
        return {
            ...row,
            author: author_username
                ? { username: author_username, display_name: author_display_name, avatar_id: author_avatar_id!, status: author_status! }
                : null,
        } as CommentRow;
    });
}

// Serialises a page of comments with their reply trees. Each node gets `replies` and `more_replies`
// (replies that exist but were not loaded: fetch them from /v1/comments/:id/replies).
async function buildTree(
    top: CommentRow[],
    levels: number,
    perParent: number,
    sort: CommentSort,
    communityId: string,
    context: ViewerContext
): Promise<PublicComment[]> {
    const descendants = await loadDescendants(top, levels, perParent, sort);
    const all = [...top, ...descendants];
    const { votes, saved } = await commentViewerState(context?.userId, all.map((comment) => comment.id));

    const nodes = new Map<string, PublicComment>();
    const depthOf = new Map<string, number>();
    for (const comment of top) {
        nodes.set(comment.id, { ...toPublicComment(comment, communityId, context, votes, saved), replies: [] });
        depthOf.set(comment.id, 0);
    }
    // Rows arrive ordered by depth, so a parent is always placed before its replies
    for (const comment of descendants) {
        const parent = comment.parent_id ? nodes.get(comment.parent_id) : undefined;
        const level = comment.parent_id ? (depthOf.get(comment.parent_id) ?? Infinity) + 1 : Infinity;
        if (!parent || level > levels) continue;
        const node: PublicComment = { ...toPublicComment(comment, communityId, context, votes, saved), replies: [] };
        parent.replies!.push(node);
        nodes.set(comment.id, node);
        depthOf.set(comment.id, level);
    }
    for (const node of nodes.values()) {
        node.more_replies = Math.max(node.reply_count - (node.replies?.length ?? 0), 0);
    }
    return top.map((comment) => nodes.get(comment.id)!);
}

type ThreadOptions = {
    postId: string;
    communityId: string;
    sort: CommentSort;
    cursor?: string;
    limit: number;
    depth: number;
    replies: number;
    context: ViewerContext;
};

// Top-level comments for a post (keyset paginated), each with its first few levels of replies.
// Pinned comments lead the first page.
export async function listPostComments({ postId, communityId, sort, cursor, limit, depth, replies, context }: ThreadOptions) {
    const { field, direction } = SORTS[sort];
    const decoded = decodeCursor(cursor);
    const base = { post_id: postId, depth: 0, status: { in: THREAD_COMMENT_STATUSES } };

    const pinned = decoded
        ? []
        : await prisma.comment.findMany({
              where: { ...base, pinned_at: { not: null } },
              orderBy: { pinned_at: 'desc' },
              include: commentInclude,
          });

    const rows = await prisma.comment.findMany({
        where: { AND: [base, { pinned_at: null }, afterCursor(field, direction, decoded)] },
        orderBy: [{ [field]: direction }, { id: direction }],
        take: limit + 1,
        include: commentInclude,
    });
    const { items, next_cursor } = paginate(rows, limit, field);

    return {
        comments: await buildTree([...pinned, ...items], depth, replies, sort, communityId, context),
        next_cursor,
    };
}

// Direct replies to one comment (keyset paginated), each with its own replies. Also serves "continue thread".
export async function listReplies(
    parentId: string,
    communityId: string,
    options: { sort: CommentSort; cursor?: string; limit: number; depth: number; replies: number; context: ViewerContext }
) {
    const { field, direction } = SORTS[options.sort];
    const rows = await prisma.comment.findMany({
        where: {
            AND: [
                { parent_id: parentId, status: { in: THREAD_COMMENT_STATUSES } },
                afterCursor(field, direction, decodeCursor(options.cursor)),
            ],
        },
        orderBy: [{ [field]: direction }, { id: direction }],
        take: options.limit + 1,
        include: commentInclude,
    });
    const { items, next_cursor } = paginate(rows, options.limit, field);
    return {
        comments: await buildTree(items, options.depth, options.replies, options.sort, communityId, options.context),
        next_cursor,
    };
}

type CreateCommentInput = { postId: string; authorId: string; body: string; parentId?: string; isAnonymous: boolean };

// Creates a comment or reply and bumps the post's comment count and the parent's reply count together
export async function createComment(input: CreateCommentInput) {
    let parent: ParentRef | null = null;
    if (input.parentId) {
        const found = await prisma.comment.findUnique({ where: { id: input.parentId } });
        if (!found || found.post_id !== input.postId) {
            throw badRequest('That comment is not part of this post.', 'parent_mismatch');
        }
        if (found.status === 'deleted' || found.status === 'removed' || found.status === 'pending') {
            throw badRequest("You can't reply to that comment.", 'parent_unavailable');
        }
        if (found.status === 'locked') throw forbidden('Replies to this comment are locked.', 'comment_locked');
        if (found.depth + 1 > MAX_COMMENT_DEPTH) throw badRequest('This thread is too deep to reply to.', 'too_deep');
        parent = found;
    }

    return withShortIdRetry((shortId) =>
        prisma.$transaction(async (tx) => {
            const comment = await tx.comment.create({
                data: {
                    short_id: shortId,
                    post_id: input.postId,
                    author_id: input.authorId,
                    parent_id: parent?.id ?? null,
                    root_id: parent ? (parent.root_id ?? parent.id) : null,
                    depth: parent ? parent.depth + 1 : 0,
                    path: parent ? `${parent.path}/${shortId}` : shortId,
                    body: input.body,
                    is_anonymous: input.isAnonymous,
                },
                include: commentInclude,
            });
            await tx.post.update({ where: { id: input.postId }, data: { comment_count: { increment: 1 } } });
            if (parent) {
                await tx.comment.update({ where: { id: parent.id }, data: { reply_count: { increment: 1 } } });
            }
            return comment;
        })
    );
}

// Moves a comment out of the visible count when it is deleted or removed, and back when approved
export async function setCommentStatus(
    comment: { id: string; post_id: string; status: string },
    status: 'active' | 'removed' | 'deleted' | 'locked',
    extra: Prisma.CommentUpdateInput = {}
) {
    const counted = (value: string) => value === 'active' || value === 'locked';
    const change = (counted(status) ? 1 : 0) - (counted(comment.status) ? 1 : 0);
    return prisma.$transaction(async (tx) => {
        const updated = await tx.comment.update({ where: { id: comment.id }, data: { status, ...extra }, include: commentInclude });
        if (change !== 0) {
            await tx.post.update({ where: { id: comment.post_id }, data: { comment_count: { increment: change } } });
        }
        return updated;
    });
}

export function assertCommentable(post: { status: string }) {
    if (post.status === 'locked') throw new HttpError(403, 'post_locked', 'This post is locked; new comments are off.');
    if (post.status !== 'active') throw badRequest("You can't comment on this post.", 'post_unavailable');
}
