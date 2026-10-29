import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { track } from '../../lib/analytics';
import { z } from 'zod';
import prisma from '../../prismaConnection';
import { parse } from '../../lib/http';
import { commentInclude, postInclude, toPublicComment } from '../../lib/serializers';
import { communityName } from '../../shared/validation';
import { commentViewerState } from '../votes/service';
import { AuthRequest, optionalAuth } from '../../middlewares/auth';
import { toPublicCommunity } from '../communities/routes';
import { viewerContext } from '../communities/access';
import { serializePosts } from '../posts/service';

const router = Router();

const PAGE_SIZE = 20;
const MAX_PAGE = 10;
// Fewer first-page results than this and the response suggests a spelling and similar community names
const FEW_RESULTS = 3;

const searchQuery = z.object({
    q: z.string().trim().min(2).max(200),
    type: z.enum(['posts', 'comments', 'communities']).default('posts'),
    // Only this community ("Search in c/x")
    community: communityName.optional(),
    page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
});

type SearchQuery = z.infer<typeof searchQuery>;

// Full-text search on the generated tsvector columns (GIN-indexed). websearch syntax: "exact phrase", -exclude, or.
// Ranked results can't use keyset paging, so this pages by number and stops at page 10. Only public, active
// communities are searched, with the same visibility rules as their pages.
router.get('/', optionalAuth, async (request: AuthRequest, response) => {
    const query = parse(searchQuery, request.query);
    const offset = (query.page - 1) * PAGE_SIZE;

    // A community filter that matches nothing public finds nothing, rather than searching everywhere
    let communityId: string | null = null;
    if (query.community) {
        const community = await prisma.community.findFirst({
            where: { name: query.community, status: 'active', visibility: 'public' },
            select: { id: true },
        });
        if (!community) return response.json({ [query.type]: [], next_page: null, did_you_mean: null, related_communities: [] });
        communityId = community.id;
    }
    const inCommunity = communityId ? Prisma.sql`AND c."id" = ${communityId}::uuid` : Prisma.empty;

    if (query.type === 'communities') {
        const ids = await prisma.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "Community"
            WHERE "status" = 'active' AND "search_vector" @@ websearch_to_tsquery('english', ${query.q})
            ORDER BY ts_rank_cd("search_vector", websearch_to_tsquery('english', ${query.q})) DESC, "member_count" DESC
            LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`;
        const pageIds = ids.slice(0, PAGE_SIZE).map((row) => row.id);
        // Few matches: add communities whose names look like what was typed ("lagos rnt" finds lagos_rent)
        const fuzzy = query.page === 1 && ids.length < FEW_RESULTS ? await similarCommunities(query.q, pageIds) : [];
        const rows = await prisma.community.findMany({ where: { id: { in: [...pageIds, ...fuzzy.map((row) => row.id)] } } });
        const byId = new Map(rows.map((row) => [row.id, row]));
        trackSearch(request, query, ids.length + fuzzy.length);
        return response.json({
            communities: [...pageIds, ...fuzzy.map((row) => row.id)].flatMap((id) => (byId.has(id) ? [toPublicCommunity(byId.get(id)!)] : [])),
            next_page: ids.length > PAGE_SIZE && query.page < MAX_PAGE ? query.page + 1 : null,
            did_you_mean: query.page === 1 && ids.length + fuzzy.length < FEW_RESULTS ? await didYouMean(query, communityId) : null,
        });
    }

    const context = await viewerContext(request.viewer);

    if (query.type === 'comments') {
        const ids = await prisma.$queryRaw<{ id: string }[]>`
            SELECT cm."id" FROM "Comment" cm
            JOIN "Post" p ON p."id" = cm."post_id"
            JOIN "Community" c ON c."id" = p."community_id"
            WHERE cm."status" IN ('active', 'locked') AND NOT cm."shadow_hidden"
              AND p."status" IN ('active', 'locked') AND NOT p."shadow_hidden" AND c."status" = 'active' AND c."visibility" = 'public'
              ${inCommunity}
              AND cm."search_vector" @@ websearch_to_tsquery('english', ${query.q})
            ORDER BY ts_rank_cd(cm."search_vector", websearch_to_tsquery('english', ${query.q})) DESC, cm."score" DESC
            LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`;
        const pageIds = ids.slice(0, PAGE_SIZE).map((row) => row.id);
        const rows = await prisma.comment.findMany({
            where: { id: { in: pageIds } },
            include: {
                ...commentInclude,
                post: { select: { community_id: true, short_id: true, slug: true, title: true, community: { select: { name: true } } } },
            },
        });
        const byId = new Map(rows.map((row) => [row.id, row]));
        const { votes, saved } = await commentViewerState(context?.userId, pageIds);
        trackSearch(request, query, ids.length);
        return response.json({
            // Same shape as saved comments: each carries its post, for the permalink /c/{community}/{post}?comment={id}
            comments: pageIds.flatMap((id) => {
                const row = byId.get(id);
                if (!row) return [];
                return [
                    {
                        ...toPublicComment(row, row.post.community_id, context, votes, saved),
                        post: { short_id: row.post.short_id, slug: row.post.slug, title: row.post.title, community: row.post.community.name },
                    },
                ];
            }),
            next_page: ids.length > PAGE_SIZE && query.page < MAX_PAGE ? query.page + 1 : null,
            ...(await fewResultHints(query, ids.length, communityId)),
        });
    }

    const ids = await prisma.$queryRaw<{ id: string }[]>`
        SELECT p."id" FROM "Post" p
        JOIN "Community" c ON c."id" = p."community_id"
        WHERE p."status" IN ('active', 'locked') AND NOT p."shadow_hidden" AND c."status" = 'active' AND c."visibility" = 'public'
          ${inCommunity}
          AND p."search_vector" @@ websearch_to_tsquery('english', ${query.q})
        ORDER BY ts_rank_cd(p."search_vector", websearch_to_tsquery('english', ${query.q})) DESC, p."hot_rank" DESC
        LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`;
    const pageIds = ids.slice(0, PAGE_SIZE).map((row) => row.id);
    const rows = await prisma.post.findMany({ where: { id: { in: pageIds } }, include: postInclude });
    const ordered = pageIds.flatMap((id) => rows.filter((row) => row.id === id));
    trackSearch(request, query, ids.length);
    response.json({
        posts: await serializePosts(ordered, context),
        next_page: ids.length > PAGE_SIZE && query.page < MAX_PAGE ? query.page + 1 : null,
        ...(await fewResultHints(query, ids.length, communityId)),
    });
});

// Typo forgiveness, for first pages that found little: a corrected query and communities with a similar name
async function fewResultHints(query: SearchQuery, found: number, communityId: string | null) {
    if (query.page !== 1 || found >= FEW_RESULTS) return { did_you_mean: null, related_communities: [] };
    const [suggestion, similar] = await Promise.all([
        didYouMean(query, communityId),
        communityId ? Promise.resolve([]) : similarCommunities(query.q, []),
    ]);
    const rows = similar.length ? await prisma.community.findMany({ where: { id: { in: similar.map((row) => row.id) } } }) : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    return {
        did_you_mean: suggestion,
        related_communities: similar.flatMap((row) => (byId.has(row.id) ? [toPublicCommunity(byId.get(row.id)!)] : [])),
    };
}

const WORD = /^[\p{L}]{3,30}$/u;

// "Did you mean ...?" Each word of the query that no title or community name uses is swapped for the closest word
// that is used (pg_trgm similarity over SearchWord, which the trending job refreshes). Only offered when the
// corrected query finds something. Quoted phrases and -exclusions are left as typed.
async function didYouMean(query: SearchQuery, communityId: string | null): Promise<string | null> {
    const parts = query.q.toLowerCase().split(/\s+/);
    if (query.q.includes('"')) return null;
    const words = [...new Set(parts.filter((part) => WORD.test(part)))];
    if (words.length === 0 || words.length > 6) return null;

    const rows = await prisma.$queryRaw<{ word: string; known: boolean; best: string | null }[]>`
        SELECT q.word,
               EXISTS (SELECT 1 FROM "SearchWord" s WHERE s."word" = q.word) AS known,
               (SELECT s."word" FROM "SearchWord" s
                WHERE s."word" % q.word AND s."word" <> q.word
                ORDER BY similarity(s."word", q.word) DESC, s."docs" DESC LIMIT 1) AS best
        FROM unnest(${words}::text[]) AS q(word)`;
    const swaps = new Map(rows.filter((row) => !row.known && row.best).map((row) => [row.word, row.best!]));
    if (swaps.size === 0) return null;
    const suggestion = parts.map((part) => swaps.get(part) ?? part).join(' ');

    const inCommunity = communityId ? Prisma.sql`AND c."id" = ${communityId}::uuid` : Prisma.empty;
    const table =
        query.type === 'communities'
            ? Prisma.sql`SELECT 1 FROM "Community" c WHERE c."status" = 'active' AND c."search_vector" @@ websearch_to_tsquery('english', ${suggestion})`
            : query.type === 'comments'
              ? Prisma.sql`SELECT 1 FROM "Comment" cm JOIN "Post" p ON p."id" = cm."post_id" JOIN "Community" c ON c."id" = p."community_id"
                  WHERE cm."status" IN ('active', 'locked') AND NOT cm."shadow_hidden" AND c."visibility" = 'public' AND c."status" = 'active'
                  ${inCommunity} AND cm."search_vector" @@ websearch_to_tsquery('english', ${suggestion})`
              : Prisma.sql`SELECT 1 FROM "Post" p JOIN "Community" c ON c."id" = p."community_id"
                  WHERE p."status" IN ('active', 'locked') AND NOT p."shadow_hidden" AND c."visibility" = 'public' AND c."status" = 'active'
                  ${inCommunity} AND p."search_vector" @@ websearch_to_tsquery('english', ${suggestion})`;
    const [hit] = await prisma.$queryRaw<{ found: boolean }[]>`SELECT EXISTS (${table}) AS found`;
    return hit.found ? suggestion : null;
}

// Public communities whose name is close to the query (trigram similarity on the indexed name), best first
async function similarCommunities(q: string, exclude: string[]) {
    const handle = q.toLowerCase().trim().replace(/[\s-]+/g, '_');
    return prisma.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Community"
        WHERE "status" = 'active' AND "visibility" = 'public' AND NOT ("id" = ANY(${exclude}::uuid[]))
          AND ("name" % ${handle} OR word_similarity(${handle}, "name") > 0.5)
        ORDER BY greatest(similarity("name", ${handle}), word_similarity(${handle}, "name")) DESC, "member_count" DESC
        LIMIT 5`;
}

// First pages only, so paging through results isn't counted as more searches. The words are kept (lowercased,
// capped) because searches that find nothing show which threads the site is missing.
function trackSearch(request: AuthRequest, query: SearchQuery, found: number) {
    if (query.page !== 1) return;
    track('search', request.viewer?.user.id, {
        type: query.type,
        in_community: Boolean(query.community),
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
