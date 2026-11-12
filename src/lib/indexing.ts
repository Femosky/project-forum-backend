import { Prisma } from '@prisma/client';

// Which posts search engines should index. Thin pages hurt the whole site's ranking, so a post is held back
// (noindex, left out of the sitemap) while it is:
//   - removed, pending or shadow-hidden, or in a private or closed community;
//   - marked mature (NSFW), itself or by its community: those pages also say rating=adult for SafeSearch;
//   - deleted by its author with no comments left (a deleted post with comments is still worth indexing);
//   - written by an account that was under a day old when it posted, until it gets a reply or an upvote;
//   - short (a text post whose body is under THIN_WORDS words) with no replies yet. A reply makes it a discussion.
// The same rule is written twice, once for a loaded post and once as SQL for the sitemap; keep them in step.
//
// Communities and profiles follow the same idea (AdSense turned the site down for "low value content" while most
// of these pages were near-empty): a community is indexed once it holds COMMUNITY_MIN_THREADS threads, and a profile
// once a real (non-seed) account has USER_MIN_ACTIVITY public posts and replies. Below that the page still works for
// people and crawlers still follow its links (noindex, follow), it just stays out of search and the sitemap.

export const NEW_ACCOUNT_MS = 24 * 60 * 60 * 1000;
export const THIN_WORDS = 80;
export const COMMUNITY_MIN_THREADS = 5;
export const USER_MIN_ACTIVITY = 3;

export const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

type IndexablePost = {
    status: string;
    shadow_hidden: boolean;
    is_nsfw: boolean;
    type: string;
    title: string;
    body: string;
    created_at: Date;
    upvote_count: number;
    comment_count: number;
    community: { visibility: string; status?: string; is_nsfw?: boolean };
    author: { created_at: Date } | null;
};

export function isIndexable(post: IndexablePost): boolean {
    const isTombstone = post.status === 'deleted' && post.comment_count > 0;
    if (post.status !== 'active' && post.status !== 'locked' && !isTombstone) return false;
    if (post.shadow_hidden || post.is_nsfw || post.community.is_nsfw) return false;
    if (post.community.visibility !== 'public' || (post.community.status ?? 'active') !== 'active') return false;

    const hasEngagement = post.comment_count > 0 || post.upvote_count > 0;
    const byNewAccount = post.author ? post.created_at.getTime() - post.author.created_at.getTime() < NEW_ACCOUNT_MS : false;
    if (byNewAccount && !hasEngagement) return false;

    const isThin = post.type === 'text' && wordCount(post.body) < THIN_WORDS;
    return !(isThin && post.comment_count === 0);
}

// The same rule for raw SQL, over "Post" p JOIN "Community" c JOIN "User" u
export const INDEXABLE_POST_SQL = Prisma.sql`
    (p."status" IN ('active', 'locked') OR (p."status" = 'deleted' AND p."comment_count" > 0)) AND NOT p."shadow_hidden" AND NOT p."is_nsfw" AND NOT c."is_nsfw" AND c."status" = 'active' AND c."visibility" = 'public'
    AND (p."comment_count" > 0 OR p."upvote_count" > 0 OR p."created_at" - u."created_at" >= interval '24 hours')
    AND NOT (p."type" = 'text' AND p."comment_count" = 0
             AND coalesce(array_length(regexp_split_to_array(nullif(btrim(p."body"), ''), '[[:space:]]+'), 1), 0) < ${THIN_WORDS})`;

type IndexableCommunity = { status: string; visibility: string; post_count: number };

export const isCommunityIndexable = (community: IndexableCommunity) =>
    community.status === 'active' && community.visibility === 'public' && community.post_count >= COMMUNITY_MIN_THREADS;

// The same rule for raw SQL over "Community" (unaliased)
export const INDEXABLE_COMMUNITY_SQL = Prisma.sql`"status" = 'active' AND "visibility" = 'public' AND "post_count" >= ${COMMUNITY_MIN_THREADS}`;

type IndexableUser = { status: string; is_seed: boolean };

// activity: the account's public, non-anonymous posts and replies that are still up (see publicActivity)
export const isUserIndexable = (user: IndexableUser, activity: number) =>
    user.status === 'active' && !user.is_seed && activity >= USER_MIN_ACTIVITY;

// The same rule for raw SQL over "User" u
export const INDEXABLE_USER_SQL = Prisma.sql`
    u."status" = 'active' AND NOT u."is_seed" AND (
        (SELECT count(*) FROM "Post" p JOIN "Community" c ON c."id" = p."community_id"
         WHERE p."author_id" = u."id" AND NOT p."is_anonymous" AND p."status" IN ('active', 'locked') AND c."visibility" = 'public')
      + (SELECT count(*) FROM "Comment" m JOIN "Post" p ON p."id" = m."post_id" JOIN "Community" c ON c."id" = p."community_id"
         WHERE m."author_id" = u."id" AND NOT m."is_anonymous" AND m."status" IN ('active', 'locked') AND c."visibility" = 'public')
    ) >= ${USER_MIN_ACTIVITY}`;
