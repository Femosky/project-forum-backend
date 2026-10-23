import { ContentStatus, Prisma } from '@prisma/client';
import { canModerate, ViewerContext } from '../modules/communities/access';
import { isIndexable } from './indexing';

// The only way posts and comments leave the API. Anonymous authors are hidden from everyone except the author
// and moderators of that community; deleted and removed comments become placeholders.

export const authorSelect = { username: true, display_name: true, avatar_id: true, status: true } as const;

export const postInclude = {
    // created_at feeds the indexing rule (posts by brand-new accounts wait for engagement); it is not sent out
    author: { select: { ...authorSelect, created_at: true } },
    community: { select: { id: true, name: true, display_name: true, image_url: true, visibility: true, status: true } },
    flair: { select: { id: true, name: true, color: true } },
} satisfies Prisma.PostInclude;

export type PostRow = Prisma.PostGetPayload<{ include: typeof postInclude }>;

type AuthorRow = { username: string; display_name: string | null; avatar_id: string; status: string } | null;

// Statuses public lists may show. Pending content waits for a moderator; removed and deleted posts drop out.
export const LISTED_POST_STATUSES: ContentStatus[] = ['active', 'locked'];
// Comments stay in the tree as placeholders when deleted or removed, so replies keep their parent
export const THREAD_COMMENT_STATUSES: ContentStatus[] = ['active', 'locked', 'removed', 'deleted'];

function publicAuthor(author: AuthorRow) {
    if (!author || author.status === 'deleted') return null;
    return { username: author.username, display_name: author.display_name, avatar_id: author.avatar_id };
}

export type VoteMap = Map<string, number>;
export type SavedSet = Set<string>;

export function toPublicPost(post: PostRow, context: ViewerContext, votes?: VoteMap, saved?: SavedSet) {
    const isAuthor = context?.userId === post.author_id;
    const revealAuthor = !post.is_anonymous || isAuthor || canModerate(context, post.community_id);

    return {
        id: post.id,
        short_id: post.short_id,
        slug: post.slug,
        type: post.type,
        title: post.title,
        body: post.body,
        url: post.url,
        link_preview: post.link_preview,
        ai_summary: post.ai_summary,
        is_anonymous: post.is_anonymous,
        is_nsfw: post.is_nsfw,
        is_sponsored: post.is_sponsored,
        status: post.status,
        flair: post.flair,
        created_at: post.created_at,
        edited_at: post.edited_at,
        pinned_at: post.pinned_at,
        upvote_count: post.upvote_count,
        downvote_count: post.downvote_count,
        score: post.score,
        comment_count: post.comment_count,
        // Whether search engines should index this post's page (see lib/indexing.ts)
        is_indexable: isIndexable(post),
        community: { id: post.community.id, name: post.community.name, display_name: post.community.display_name, image_url: post.community.image_url },
        author: revealAuthor ? publicAuthor(post.author) : null,
        viewer: context
            ? { vote: votes?.get(post.id) ?? 0, saved: saved?.has(post.id) ?? false, is_author: isAuthor }
            : null,
    };
}

export type PublicPost = ReturnType<typeof toPublicPost>;

export type CommentRow = {
    id: string;
    short_id: string;
    post_id: string;
    author_id: string;
    parent_id: string | null;
    root_id: string | null;
    depth: number;
    path: string;
    body: string;
    is_anonymous: boolean;
    is_sponsored: boolean;
    status: ContentStatus;
    created_at: Date;
    edited_at: Date | null;
    pinned_at: Date | null;
    upvote_count: number;
    downvote_count: number;
    score: number;
    reply_count: number;
    best_rank: number;
    author: AuthorRow;
};

export const commentInclude = { author: { select: authorSelect } } satisfies Prisma.CommentInclude;

export function toPublicComment(comment: CommentRow, communityId: string, context: ViewerContext, votes?: VoteMap, saved?: SavedSet) {
    const isAuthor = context?.userId === comment.author_id;
    const isMod = canModerate(context, communityId);
    const isGone = comment.status === 'deleted' || comment.status === 'removed';
    // Moderators can still read what they removed; nobody can read what an author deleted
    const showBody = !isGone || (comment.status === 'removed' && isMod);
    const revealAuthor = !isGone && (!comment.is_anonymous || isAuthor || isMod);

    return {
        id: comment.id,
        short_id: comment.short_id,
        post_id: comment.post_id,
        parent_id: comment.parent_id,
        depth: comment.depth,
        body: showBody ? comment.body : comment.status === 'deleted' ? '[deleted]' : '[removed]',
        is_anonymous: comment.is_anonymous,
        is_sponsored: comment.is_sponsored,
        status: comment.status,
        created_at: comment.created_at,
        edited_at: comment.edited_at,
        pinned_at: comment.pinned_at,
        upvote_count: comment.upvote_count,
        downvote_count: comment.downvote_count,
        score: comment.score,
        reply_count: comment.reply_count,
        author: revealAuthor ? publicAuthor(comment.author) : null,
        viewer: context
            ? { vote: votes?.get(comment.id) ?? 0, saved: saved?.has(comment.id) ?? false, is_author: isAuthor }
            : null,
    };
}

export type PublicComment = ReturnType<typeof toPublicComment> & { replies?: PublicComment[]; more_replies?: number };
