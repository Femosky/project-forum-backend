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
import { ViewerContext, viewerContext } from '../communities/access';
import { serializePosts } from '../posts/service';

const router = Router();

const PAGE_SIZE = 20;
const MAX_PAGE = 10;
// Fewer first-page results than this and the response suggests a spelling and similar community names
const FEW_RESULTS = 3;
// A correction this close to every misspelt word (trigram similarity) is used straight away instead of suggested
const CONFIDENT_SIMILARITY = 0.45;

const searchQuery = z.object({
    q: z.string().trim().min(2).max(200),
    type: z.enum(['posts', 'comments', 'communities']).default('posts'),
    // Only this community ("Search in c/x")
    community: communityName.optional(),
    page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
    // "Search instead for ...": the words exactly as typed, no correction
    exact: z.enum(['1', 'true']).optional(),
});

type SearchQuery = z.infer<typeof searchQuery>;
type Scope = { type: SearchQuery['type']; page: number; communityId: string | null; context: ViewerContext };

const inCommunity = (communityId: string | null) => (communityId ? Prisma.sql`AND c."id" = ${communityId}::uuid` : Prisma.empty);

// One page of matching ids, best first, plus one extra to tell whether there's a next page
function matchingIds(q: string, { type, page, communityId }: Scope) {
    const offset = (page - 1) * PAGE_SIZE;
    if (type === 'communities') {
        return prisma.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "Community"
            WHERE "status" = 'active' AND "search_vector" @@ websearch_to_tsquery('english', ${q})
            ORDER BY ts_rank_cd("search_vector", websearch_to_tsquery('english', ${q})) DESC, "member_count" DESC
            LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`;
    }
    if (type === 'comments') {
        return prisma.$queryRaw<{ id: string }[]>`
            SELECT cm."id" FROM "Comment" cm
            JOIN "Post" p ON p."id" = cm."post_id"
            JOIN "Community" c ON c."id" = p."community_id"
            WHERE cm."status" IN ('active', 'locked') AND NOT cm."shadow_hidden"
              AND p."status" IN ('active', 'locked') AND NOT p."shadow_hidden" AND c."status" = 'active' AND c."visibility" = 'public'
              ${inCommunity(communityId)}
              AND cm."search_vector" @@ websearch_to_tsquery('english', ${q})
            ORDER BY ts_rank_cd(cm."search_vector", websearch_to_tsquery('english', ${q})) DESC, cm."score" DESC
            LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`;
    }
    return prisma.$queryRaw<{ id: string }[]>`
        SELECT p."id" FROM "Post" p
        JOIN "Community" c ON c."id" = p."community_id"
        WHERE p."status" IN ('active', 'locked') AND NOT p."shadow_hidden" AND c."status" = 'active' AND c."visibility" = 'public'
          ${inCommunity(communityId)}
          AND p."search_vector" @@ websearch_to_tsquery('english', ${q})
        ORDER BY ts_rank_cd(p."search_vector", websearch_to_tsquery('english', ${q})) DESC, p."hot_rank" DESC
        LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`;
}

// The page of results for those ids, in the same order
async function serialize(ids: string[], { type, context }: Scope) {
    if (type === 'communities') {
        const rows = await prisma.community.findMany({ where: { id: { in: ids } } });
        const byId = new Map(rows.map((row) => [row.id, row]));
        return { communities: ids.flatMap((id) => (byId.has(id) ? [toPublicCommunity(byId.get(id)!)] : [])) };
    }
    if (type === 'comments') {
        const rows = await prisma.comment.findMany({
            where: { id: { in: ids } },
            include: {
                ...commentInclude,
                post: { select: { community_id: true, short_id: true, slug: true, title: true, community: { select: { name: true } } } },
            },
        });
        const byId = new Map(rows.map((row) => [row.id, row]));
        const { votes, saved } = await commentViewerState(context?.userId, ids);
        // Same shape as saved comments: each carries its post, for the permalink /c/{community}/{post}?comment={id}
        return {
            comments: ids.flatMap((id) => {
                const row = byId.get(id);
                if (!row) return [];
                return [
                    {
                        ...toPublicComment(row, row.post.community_id, context, votes, saved),
                        post: { short_id: row.post.short_id, slug: row.post.slug, title: row.post.title, community: row.post.community.name },
                    },
                ];
            }),
        };
    }
    const rows = await prisma.post.findMany({ where: { id: { in: ids } }, include: postInclude });
    return { posts: await serializePosts(ids.flatMap((id) => rows.filter((row) => row.id === id)), context) };
}

// Full-text search on the generated tsvector columns (GIN-indexed). websearch syntax: "exact phrase", -exclude, or.
// Ranked results can't use keyset paging, so this pages by number and stops at page 10. Only public, active
// communities are searched, with the same visibility rules as their pages.
//
// Typos: when a first page finds little and a correction is confident (every misspelt word is close to a word
// titles actually use, and the correction finds more), the results are for the correction, with `corrected_from`
// set so the page can say "Showing results for ... Search instead for ...". A weaker correction is only offered as
// `did_you_mean`. `exact=1` turns correction off.
router.get('/', optionalAuth, async (request: AuthRequest, response) => {
    const query = parse(searchQuery, request.query);

    // A community filter that matches nothing public finds nothing, rather than searching everywhere
    let communityId: string | null = null;
    if (query.community) {
        const community = await prisma.community.findFirst({
            where: { name: query.community, status: 'active', visibility: 'public' },
            select: { id: true },
        });
        if (!community) {
            return response.json({ [query.type]: [], next_page: null, did_you_mean: null, corrected_from: null, related_communities: [] });
        }
        communityId = community.id;
    }
    const scope: Scope = { type: query.type, page: query.page, communityId, context: await viewerContext(request.viewer) };

    let q = query.q;
    let ids = await matchingIds(q, scope);
    let correctedFrom: string | null = null;
    let didYouMean: string | null = null;
    if (query.page === 1 && ids.length < FEW_RESULTS && !query.exact) {
        const correction = await correct(query.q, scope);
        if (correction?.confident) {
            const better = await matchingIds(correction.query, scope);
            if (better.length > ids.length) {
                correctedFrom = query.q;
                q = correction.query;
                ids = better;
            } else didYouMean = correction.query;
        } else if (correction) didYouMean = correction.query;
    }

    const pageIds = ids.slice(0, PAGE_SIZE).map((row) => row.id);
    // Few matches for communities: add ones whose names look like what was typed ("lagos rnt" finds LagosRent)
    const similar = query.page === 1 && ids.length < FEW_RESULTS ? await similarCommunities(query.q, query.type === 'communities' ? pageIds : []) : [];
    const results = await serialize(query.type === 'communities' ? [...pageIds, ...similar.map((row) => row.id)] : pageIds, scope);
    const related =
        query.type !== 'communities' && !communityId && similar.length
            ? (await serialize(similar.map((row) => row.id), { ...scope, type: 'communities' })).communities!
            : [];

    trackSearch(request, query, ids.length, correctedFrom !== null);
    response.json({
        ...results,
        next_page: ids.length > PAGE_SIZE && query.page < MAX_PAGE ? query.page + 1 : null,
        // The words the results are for, when that isn't what was typed
        query: q,
        corrected_from: correctedFrom,
        did_you_mean: didYouMean,
        ...(query.type === 'communities' ? {} : { related_communities: related }),
    });
});

const WORD = /^[\p{L}]{3,30}$/u;

// A spelling correction for the query: each word that no title or community name uses is swapped for the closest
// word that is used (pg_trgm similarity over SearchWord, which the trending job refreshes). Only offered when the
// corrected query finds something; confident when every swap is close. Quoted phrases and -exclusions are left alone.
async function correct(text: string, scope: Scope): Promise<{ query: string; confident: boolean } | null> {
    const parts = text.toLowerCase().split(/\s+/);
    if (text.includes('"')) return null;
    const words = [...new Set(parts.filter((part) => WORD.test(part)))];
    if (words.length === 0 || words.length > 6) return null;

    const rows = await prisma.$queryRaw<{ word: string; known: boolean; best: string | null; similarity: number | null }[]>`
        SELECT q.word,
               EXISTS (SELECT 1 FROM "SearchWord" s WHERE s."word" = q.word) AS known,
               b.word AS best, b.similarity
        FROM unnest(${words}::text[]) AS q(word)
        LEFT JOIN LATERAL (
            SELECT s."word", similarity(s."word", q.word) AS similarity FROM "SearchWord" s
            WHERE s."word" % q.word AND s."word" <> q.word
            ORDER BY similarity(s."word", q.word) DESC, s."docs" DESC LIMIT 1
        ) b ON true`;
    const swaps = rows.filter((row) => !row.known && row.best);
    if (swaps.length === 0) return null;
    const replace = new Map(swaps.map((row) => [row.word, row.best!]));
    const suggestion = parts.map((part) => replace.get(part) ?? part).join(' ');

    const [hit] = await matchingIds(suggestion, { ...scope, page: 1 });
    if (!hit) return null;
    return { query: suggestion, confident: swaps.every((row) => (row.similarity ?? 0) >= CONFIDENT_SIMILARITY) };
}

// Public communities whose name is close to the query (trigram similarity on the indexed name), best first
async function similarCommunities(q: string, exclude: string[]) {
    const handle = q.toLowerCase().trim().replace(/[\s_-]+/g, '');
    return prisma.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Community"
        WHERE "status" = 'active' AND "visibility" = 'public' AND NOT ("id" = ANY(${exclude}::uuid[]))
          AND (lower("name") % ${handle} OR word_similarity(${handle}, lower("name")) > 0.5)
        ORDER BY greatest(similarity(lower("name"), ${handle}), word_similarity(${handle}, lower("name"))) DESC, "member_count" DESC
        LIMIT 5`;
}

// First pages only, so paging through results isn't counted as more searches. The words are kept (lowercased,
// capped) because searches that find nothing show which threads the site is missing.
function trackSearch(request: AuthRequest, query: SearchQuery, found: number, corrected: boolean) {
    if (query.page !== 1) return;
    track('search', request.viewer?.user.id, {
        type: query.type,
        in_community: Boolean(query.community),
        query: query.q.toLowerCase().slice(0, 100),
        results: Math.min(found, PAGE_SIZE),
        no_results: found === 0,
        corrected,
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
