import { Prisma, User } from '@prisma/client';
import prisma from '../../prismaConnection';
import { afterCursor, decodeCursor, paginate } from '../../lib/cursor';
import { idOrShortId, withShortIdRetry } from '../../lib/ids';
import { notFound } from '../../lib/http';
import { hotRank, TopWindow, topWindowStart } from '../../lib/ranking';
import { isHiddenFrom, LISTED_POST_STATUSES, notShadowHidden, postInclude, PostRow, toPublicPost } from '../../lib/serializers';
import { slugify } from '../../lib/slug';
import { urlKey } from '../../lib/urls';
import { assertCanView, canModerate, ViewerContext } from '../communities/access';
import { postViewerState } from '../votes/service';
import { linkPreviewJob } from './jobs';

export type PostSort = 'hot' | 'new' | 'top';

const SORT_FIELD = { hot: 'hot_rank', new: 'created_at', top: 'score' } as const;

type ListOptions = {
    where: Prisma.PostWhereInput;
    sort: PostSort;
    window?: TopWindow;
    cursor?: string;
    limit: number;
    context: ViewerContext;
};

// One keyset-paginated query on an indexed sort column, plus one for the viewer's votes and saves
export async function listPosts({ where, sort, window = 'day', cursor, limit, context }: ListOptions) {
    const field = SORT_FIELD[sort];
    const since = sort === 'top' ? topWindowStart(window) : undefined;

    const rows = await prisma.post.findMany({
        where: {
            AND: [
                where,
                { status: { in: LISTED_POST_STATUSES } },
                notShadowHidden(context),
                since ? { created_at: { gte: since } } : {},
                afterCursor(field, 'desc', decodeCursor(cursor)),
            ],
        },
        orderBy: [{ [field]: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        include: postInclude,
    });

    const { items, next_cursor } = paginate(rows, limit, field);
    return { posts: await serializePosts(items, context), next_cursor };
}

export async function serializePosts(rows: PostRow[], context: ViewerContext) {
    const { votes, saved } = await postViewerState(context?.userId, rows.map((row) => row.id));
    return rows.map((row) => toPublicPost(row, context, votes, saved));
}

// Finds a post by id or short id that this viewer is allowed to see. Removed, deleted and pending posts are
// visible only to moderators (and pending ones to their author).
export async function findVisiblePost(idOrShort: string, viewerUser: User | undefined, context: ViewerContext) {
    const post = await prisma.post.findUnique({
        where: idOrShortId(idOrShort) as Prisma.PostWhereUniqueInput,
        include: { ...postInclude, community: true },
    });
    if (!post) throw notFound('Post not found');

    const isMod = canModerate(context, post.community_id);
    const isAuthor = context?.userId === post.author_id;
    const visible =
        LISTED_POST_STATUSES.includes(post.status) || isMod || (post.status === 'pending' && isAuthor);
    if (!visible || isHiddenFrom(post, context) || post.community.status === 'deleted') throw notFound('Post not found');

    await assertCanView(post.community, viewerUser);
    return post;
}

type CreatePostInput = {
    communityId: string;
    authorId: string;
    type: 'text' | 'link';
    title: string;
    body: string;
    url?: string;
    is_anonymous: boolean;
    is_nsfw: boolean;
    flair_id?: string;
    // Held by the filters for review, or written by a shadow-banned account
    held_reason: string | null;
    shadow_hidden: boolean;
};

export async function createPost(input: CreatePostInput) {
    const now = new Date();
    const post = await withShortIdRetry((shortId) =>
        prisma.$transaction(async (tx) => {
            const created = await tx.post.create({
                data: {
                    short_id: shortId,
                    slug: slugify(input.title),
                    community_id: input.communityId,
                    author_id: input.authorId,
                    type: input.type,
                    title: input.title,
                    body: input.body,
                    url: input.url ?? null,
                    url_key: input.url ? urlKey(input.url) : null,
                    is_anonymous: input.is_anonymous,
                    is_nsfw: input.is_nsfw,
                    flair_id: input.flair_id ?? null,
                    status: input.held_reason ? 'pending' : 'active',
                    held_reason: input.held_reason,
                    shadow_hidden: input.shadow_hidden,
                    created_at: now,
                    hot_rank: hotRank(0, now),
                },
                include: postInclude,
            });
            // Held and shadow-hidden posts aren't counted until (unless) they become visible
            if (!input.held_reason && !input.shadow_hidden) {
                await tx.community.update({ where: { id: input.communityId }, data: { post_count: { increment: 1 } } });
            }
            return created;
        })
    );

    if (post.url) await linkPreviewJob.enqueue({ postId: post.id, url: post.url });
    return post;
}

const RELATED_LIMIT = 5;

type RelatedRow = { short_id: string; slug: string; title: string; community: string; score: number; comment_count: number };

export async function relatedPosts(post: { id: string; title: string; community_id: string; community: { visibility: string } }) {
    // Any word of the title may match (OR), ranked by how well; the title's own lexemes are quoted so punctuation
    // in them can't break the query
    const related = await prisma.$queryRaw<RelatedRow[]>`
        WITH q AS (
            SELECT to_tsquery('english', string_agg(quote_literal(lexeme), ' | ')) AS query
            FROM unnest(tsvector_to_array(to_tsvector('english', ${post.title}))) AS lexeme
        )
        SELECT p."short_id", p."slug", p."title", c."name" AS community, p."score", p."comment_count"
        FROM q, "Post" p JOIN "Community" c ON c."id" = p."community_id"
        WHERE q.query IS NOT NULL AND p."id" <> ${post.id}::uuid
          AND p."status" IN ('active', 'locked') AND NOT p."shadow_hidden" AND c."status" = 'active' AND c."visibility" = 'public'
          AND p."search_vector" @@ q.query
        ORDER BY ts_rank_cd(p."search_vector", q.query) DESC, p."hot_rank" DESC
        LIMIT ${RELATED_LIMIT}`;

    const relatedIds = related.map((row) => row.short_id);
    const more = await prisma.post.findMany({
        where: {
            community_id: post.community_id,
            id: { not: post.id },
            short_id: { notIn: relatedIds },
            status: { in: LISTED_POST_STATUSES },
            shadow_hidden: false,
            created_at: { gte: topWindowStart('month') },
        },
        orderBy: [{ score: 'desc' }, { id: 'desc' }],
        take: RELATED_LIMIT,
        select: { short_id: true, slug: true, title: true, score: true, comment_count: true, community: { select: { name: true } } },
    });

    return {
        related,
        more_from_community: more.map(({ community, ...row }) => ({ ...row, community: community.name })),
    };
}
