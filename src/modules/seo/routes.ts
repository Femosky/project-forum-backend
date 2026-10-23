import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../prismaConnection';
import { notFound, parse } from '../../lib/http';
import { INDEXABLE_POST_SQL } from '../../lib/indexing';

// Data for the web app's sitemaps. Sitemaps hold at most 50,000 URLs each, so every list is split into numbered
// chunks in a stable order (oldest first: a chunk only changes when its posts are edited or new ones fill the last
// one). The web app caches these responses, so this is read about once an hour per chunk, not per crawler visit.

const router = Router();

export const SITEMAP_CHUNK = 50_000;

type Chunk = { page: number; lastmod: Date | null };

// Users worth a sitemap entry: active accounts with at least one indexable, non-anonymous post
const LISTED_USER_SQL = Prisma.sql`
    u."status" = 'active' AND EXISTS (
        SELECT 1 FROM "Post" p JOIN "Community" c ON c."id" = p."community_id"
        WHERE p."author_id" = u."id" AND NOT p."is_anonymous" AND ${INDEXABLE_POST_SQL}
    )`;

function toChunks(rows: { chunk: bigint | number; lastmod: Date | null }[]): Chunk[] {
    return rows.map((row) => ({ page: Number(row.chunk) + 1, lastmod: row.lastmod }));
}

// The sitemap index: how many chunks of each kind there are, and when each last changed
router.get('/sitemap', async (request, response) => {
    const [posts, communities, users] = await Promise.all([
        prisma.$queryRaw<{ chunk: bigint; lastmod: Date | null }[]>`
            SELECT (n - 1) / ${SITEMAP_CHUNK} AS chunk, max(lastmod) AS lastmod FROM (
                SELECT row_number() OVER (ORDER BY p."created_at", p."id") AS n, greatest(p."edited_at", p."created_at") AS lastmod
                FROM "Post" p JOIN "Community" c ON c."id" = p."community_id" JOIN "User" u ON u."id" = p."author_id"
                WHERE ${INDEXABLE_POST_SQL}
            ) numbered GROUP BY chunk ORDER BY chunk`,
        prisma.$queryRaw<{ chunk: bigint; lastmod: Date | null }[]>`
            SELECT (n - 1) / ${SITEMAP_CHUNK} AS chunk, max(lastmod) AS lastmod FROM (
                SELECT row_number() OVER (ORDER BY "created_at", "id") AS n, "updated_at" AS lastmod
                FROM "Community" WHERE "status" = 'active' AND "visibility" = 'public'
            ) numbered GROUP BY chunk ORDER BY chunk`,
        prisma.$queryRaw<{ chunk: bigint; lastmod: Date | null }[]>`
            SELECT (n - 1) / ${SITEMAP_CHUNK} AS chunk, max(lastmod) AS lastmod FROM (
                SELECT row_number() OVER (ORDER BY u."created_at", u."id") AS n, u."updated_at" AS lastmod
                FROM "User" u WHERE ${LISTED_USER_SQL}
            ) numbered GROUP BY chunk ORDER BY chunk`,
    ]);
    response.json({ posts: toChunks(posts), communities: toChunks(communities), users: toChunks(users) });
});

const chunkParams = z.object({
    kind: z.enum(['posts', 'communities', 'users']),
    page: z.coerce.number().int().min(1).max(10_000),
});

router.get('/sitemap/:kind/:page', async (request, response) => {
    const { kind, page } = parse(chunkParams, request.params);
    const offset = (page - 1) * SITEMAP_CHUNK;

    let urls: object[];
    if (kind === 'posts') {
        urls = await prisma.$queryRaw<object[]>`
            SELECT c."name" AS community, p."short_id", p."slug", greatest(p."edited_at", p."created_at") AS lastmod
            FROM "Post" p JOIN "Community" c ON c."id" = p."community_id" JOIN "User" u ON u."id" = p."author_id"
            WHERE ${INDEXABLE_POST_SQL}
            ORDER BY p."created_at", p."id" LIMIT ${SITEMAP_CHUNK} OFFSET ${offset}`;
    } else if (kind === 'communities') {
        urls = await prisma.$queryRaw<object[]>`
            SELECT "name", "updated_at" AS lastmod FROM "Community"
            WHERE "status" = 'active' AND "visibility" = 'public'
            ORDER BY "created_at", "id" LIMIT ${SITEMAP_CHUNK} OFFSET ${offset}`;
    } else {
        urls = await prisma.$queryRaw<object[]>`
            SELECT u."username", u."updated_at" AS lastmod FROM "User" u
            WHERE ${LISTED_USER_SQL}
            ORDER BY u."created_at", u."id" LIMIT ${SITEMAP_CHUNK} OFFSET ${offset}`;
    }

    if (urls.length === 0 && page > 1) throw notFound('No such sitemap page');
    response.json({ urls });
});

export default router;
