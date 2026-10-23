import { CommentStatus, PostStatus } from '@prisma/client';

// Statuses that public listings may show. Hidden and pending content is never listed.
export const VISIBLE_POST_STATUSES: PostStatus[] = [PostStatus.active, PostStatus.archived];

// Deleted and removed comments stay in the tree so replies keep their parent,
// but their content and author are redacted by toPublicComment.
export const VISIBLE_COMMENT_STATUSES: CommentStatus[] = [
    CommentStatus.active,
    CommentStatus.archived,
    CommentStatus.deleted,
    CommentStatus.removed,
];

type Content = {
    is_anonymous?: boolean;
    author_id?: string | null;
    author_ref?: unknown;
    [key: string]: unknown;
};

const stripAuthor = <T extends Content>(item: T): T => {
    const { author_id, author_ref, ...rest } = item;
    return { ...rest, author_id: null, author_ref: null } as T;
};

// The only way a post should leave a public route: hides the author of anonymous posts.
export const toPublicPost = <T extends Content>(post: T): T => {
    return post.is_anonymous ? stripAuthor(post) : post;
};

// Hides the author of anonymous comments and redacts deleted/removed ones,
// recursing into any included child comments.
export const toPublicComment = <T extends Content & { status?: CommentStatus; child_comments?: unknown }>(
    comment: T
): T => {
    let result: T = comment;

    if (comment.status === CommentStatus.deleted || comment.status === CommentStatus.removed) {
        result = stripAuthor({
            ...comment,
            content: comment.status === CommentStatus.deleted ? '[deleted]' : '[removed]',
        });
    } else if (comment.is_anonymous) {
        result = stripAuthor(comment);
    }

    if (Array.isArray(comment.child_comments)) {
        result = { ...result, child_comments: comment.child_comments.map((child) => toPublicComment(child)) };
    }

    return result;
};
