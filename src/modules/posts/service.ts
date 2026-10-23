import { Prisma, User } from '@prisma/client';
import prisma from '../../prismaConnection';
import { afterCursor, decodeCursor, paginate } from '../../lib/cursor';
import { idOrShortId, withShortIdRetry } from '../../lib/ids';
import { notFound } from '../../lib/http';
import { hotRank, TopWindow, topWindowStart } from '../../lib/ranking';
import { LISTED_POST_STATUSES, postInclude, PostRow, toPublicPost } from '../../lib/serializers';
import { slugify } from '../../lib/slug';
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
    if (!visible || post.community.status === 'deleted') throw notFound('Post not found');

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
                    is_anonymous: input.is_anonymous,
                    is_nsfw: input.is_nsfw,
                    flair_id: input.flair_id ?? null,
                    created_at: now,
                    hot_rank: hotRank(0, now),
                },
                include: postInclude,
            });
            await tx.community.update({ where: { id: input.communityId }, data: { post_count: { increment: 1 } } });
            return created;
        })
    );

    if (post.url) await linkPreviewJob.enqueue({ postId: post.id, url: post.url });
    return post;
}
