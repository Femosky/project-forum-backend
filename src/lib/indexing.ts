import { Prisma } from '@prisma/client';

// Which posts search engines should index. Thin pages hurt the whole site's ranking, so a post is held back
// (noindex, left out of the sitemap) while it is:
//   - removed, deleted or pending, or in a private or closed community;
//   - written by an account that was under a day old when it posted, until it gets a reply or an upvote;
//   - very short (a text post under THIN_TEXT_CHARS of title plus body) with no replies yet.
// The same rule is written twice, once for a loaded post and once as SQL for the sitemap; keep them in step.

export const NEW_ACCOUNT_MS = 24 * 60 * 60 * 1000;
export const THIN_TEXT_CHARS = 40;

type IndexablePost = {
    status: string;
    type: string;
    title: string;
    body: string;
    created_at: Date;
    upvote_count: number;
    comment_count: number;
    community: { visibility: string; status?: string };
    author: { created_at: Date } | null;
};

export function isIndexable(post: IndexablePost): boolean {
    if (post.status !== 'active' && post.status !== 'locked') return false;
    if (post.community.visibility !== 'public' || (post.community.status ?? 'active') !== 'active') return false;

    const hasEngagement = post.comment_count > 0 || post.upvote_count > 0;
    const byNewAccount = post.author ? post.created_at.getTime() - post.author.created_at.getTime() < NEW_ACCOUNT_MS : false;
    if (byNewAccount && !hasEngagement) return false;

    const isThin = post.type === 'text' && post.title.length + post.body.length < THIN_TEXT_CHARS;
    return !(isThin && post.comment_count === 0);
}

// The same rule for raw SQL, over "Post" p JOIN "Community" c JOIN "User" u
export const INDEXABLE_POST_SQL = Prisma.sql`
    p."status" IN ('active', 'locked') AND c."status" = 'active' AND c."visibility" = 'public'
    AND (p."comment_count" > 0 OR p."upvote_count" > 0 OR p."created_at" - u."created_at" >= interval '24 hours')
    AND NOT (p."type" = 'text' AND char_length(p."title") + char_length(p."body") < ${THIN_TEXT_CHARS} AND p."comment_count" = 0)`;
