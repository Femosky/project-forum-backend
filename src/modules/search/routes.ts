import { Router } from 'express';
import { track } from '../../lib/analytics';
import { z } from 'zod';
import prisma from '../../prismaConnection';
import { parse } from '../../lib/http';
import { postInclude } from '../../lib/serializers';
import { AuthRequest, optionalAuth } from '../../middlewares/auth';
import { toPublicCommunity } from '../communities/routes';
import { viewerContext } from '../communities/access';
import { serializePosts } from '../posts/service';

const router = Router();

const PAGE_SIZE = 20;
const MAX_PAGE = 10;

const searchQuery = z.object({
    q: z.string().trim().min(2).max(200),
    type: z.enum(['posts', 'communities']).default('posts'),
    page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
});

// Full-text search on the generated tsvector columns (GIN-indexed). websearch syntax: "exact phrase", -exclude, or.
// Ranked results can't use keyset paging, so this pages by number and stops at page 10.
router.get('/', optionalAuth, async (request: AuthRequest, response) => {
    const query = parse(searchQuery, request.query);
    const offset = (query.page - 1) * PAGE_SIZE;

    if (query.type === 'communities') {
        const ids = await prisma.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "Community"
            WHERE "status" = 'active' AND "search_vector" @@ websearch_to_tsquery('english', ${query.q})
            ORDER BY ts_rank_cd("search_vector", websearch_to_tsquery('english', ${query.q})) DESC, "member_count" DESC
            LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`;
        const rows = await prisma.community.findMany({ where: { id: { in: ids.slice(0, PAGE_SIZE).map((row) => row.id) } } });
        const byId = new Map(rows.map((row) => [row.id, row]));
        trackSearch(request, query, ids.length);
        return response.json({
            communities: ids.slice(0, PAGE_SIZE).flatMap((row) => (byId.has(row.id) ? [toPublicCommunity(byId.get(row.id)!)] : [])),
            next_page: ids.length > PAGE_SIZE && query.page < MAX_PAGE ? query.page + 1 : null,
        });
    }

    const ids = await prisma.$queryRaw<{ id: string }[]>`
        SELECT p."id" FROM "Post" p
        JOIN "Community" c ON c."id" = p."community_id"
        WHERE p."status" IN ('active', 'locked') AND NOT p."shadow_hidden" AND c."status" = 'active' AND c."visibility" = 'public'
          AND p."search_vector" @@ websearch_to_tsquery('english', ${query.q})
        ORDER BY ts_rank_cd(p."search_vector", websearch_to_tsquery('english', ${query.q})) DESC, p."hot_rank" DESC
        LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`;
    const pageIds = ids.slice(0, PAGE_SIZE).map((row) => row.id);
    const rows = await prisma.post.findMany({ where: { id: { in: pageIds } }, include: postInclude });
    const ordered = pageIds.flatMap((id) => rows.filter((row) => row.id === id));
    trackSearch(request, query, ids.length);
    response.json({
        posts: await serializePosts(ordered, await viewerContext(request.viewer)),
        next_page: ids.length > PAGE_SIZE && query.page < MAX_PAGE ? query.page + 1 : null,
    });
});

// First pages only, so paging through results isn't counted as more searches. The words are kept (lowercased,
// capped) because searches that find nothing show which threads the site is missing.
function trackSearch(request: AuthRequest, query: z.infer<typeof searchQuery>, found: number) {
    if (query.page !== 1) return;
    track('search', request.viewer?.user.id, {
        type: query.type,
        query: query.q.toLowerCase().slice(0, 100),
        results: Math.min(found, PAGE_SIZE),
        no_results: found === 0,
    });
}

const autocompleteQuery = z.object({ q: z.string().trim().min(1).max(50) });

// Prefix match on community names and usernames, served by trigram GIN indexes. Community names also match from the
// start of any word, typed with spaces ("tech car" and "careers" both find tech_careers); whole-name prefixes rank first.
router.get('/autocomplete', async (request, response) => {
    const { q } = parse(autocompleteQuery, request.query);
    const escape = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);
    const pattern = `${escape(q.toLowerCase())}%`;
    const handle = escape(q.toLowerCase().replace(/[\s-]+/g, '_'));
    // Mid-name matches need three characters for the trigram index to help; shorter ones only match the start
    const wordStart = q.length >= 3 ? `%\\_${handle}%` : `${handle}%`;

    const [communities, users] = await Promise.all([
        prisma.$queryRaw<{ name: string; display_name: string | null; image_url: string | null; member_count: number }[]>`
            SELECT "name", "display_name", "image_url", "member_count" FROM "Community"
            WHERE "status" = 'active' AND ("name" LIKE ${`${handle}%`} OR "name" LIKE ${wordStart})
            ORDER BY ("name" LIKE ${`${handle}%`}) DESC, "member_count" DESC LIMIT 8`,
        prisma.$queryRaw<{ username: string; display_name: string | null; avatar_id: string }[]>`
            SELECT "username", "display_name", "avatar_id" FROM "User"
            WHERE "status" = 'active' AND "username" LIKE ${pattern}
            ORDER BY "karma" DESC LIMIT 5`,
    ]);
    response.json({ communities, users });
});

export default router;
