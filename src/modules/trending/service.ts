import prisma from '../../prismaConnection';
import logger from '../../lib/logger';
import { extractTopics, TitleRow } from './topics';

// Trending snapshots, recomputed every 10 minutes (jobs.ts) and read by GET /v1/trending.
//
// Only content anyone may see counts: active or locked, not shadow-hidden, not NSFW, not sponsored, in an active
// public community that isn't NSFW. Only trusted accounts move anything: active, not shadow-banned, and at least a
// day old or with 10+ reputation (the same line as "new account" in safety/policy.ts). People are counted once
// each, so one account voting and replying ten times is still one person.

export const TRENDING = {
    // Engagement on a post counts for this long
    POST_WINDOW_HOURS: 48,
    // Older posts can't trend however busy they are
    POST_MAX_AGE_DAYS: 7,
    // A reply is worth this many votes (replies take more effort than a tap)
    REPLY_WEIGHT: 2,
    // Gravity: score = engagement / (age in hours + 2) ^ GRAVITY
    GRAVITY: 1.5,
    // A post needs this many different people (voters and repliers, not the author) and this much engagement
    MIN_POST_PEOPLE: 3,
    MIN_POST_ENGAGEMENT: 3,
    // Communities: growth over 7 days, from at least this many different people
    COMMUNITY_WINDOW_DAYS: 7,
    MIN_COMMUNITY_PEOPLE: 3,
    // Size damping: score = growth / sqrt(members + COMMUNITY_SIZE_OFFSET), so a small community growing fast
    // can beat a big one growing slowly
    COMMUNITY_SIZE_OFFSET: 10,
    // How many of each are kept
    KEEP: 50,
} as const;

// Accounts whose votes, replies and joins count
const TRUSTED = (alias: string) => `
    ${alias}."status" = 'active' AND ${alias}."shadow_banned_at" IS NULL
    AND (${alias}."created_at" <= (now() AT TIME ZONE 'UTC') - interval '1 day' OR ${alias}."karma" >= 10)`;

// Content anyone can see in a community anyone can browse
const PUBLIC_POST = `
    p."status" IN ('active', 'locked') AND NOT p."shadow_hidden" AND NOT p."is_nsfw" AND NOT p."is_sponsored"
    AND c."status" = 'active' AND c."visibility" = 'public' AND NOT c."is_nsfw"`;

type TrendingPostRow = { post_id: string; score: number; voters: number; repliers: number };

export async function scoreTrendingPosts(): Promise<TrendingPostRow[]> {
    const rows = await prisma.$queryRawUnsafe<{ post_id: string; score: number; voters: bigint; repliers: bigint }[]>(`
        WITH eligible AS (
            SELECT p."id", p."author_id", p."created_at" FROM "Post" p JOIN "Community" c ON c."id" = p."community_id"
            WHERE p."created_at" >= (now() AT TIME ZONE 'UTC') - interval '${TRENDING.POST_MAX_AGE_DAYS} days' AND ${PUBLIC_POST}
        ),
        votes AS (
            SELECT v."post_id", v."user_id", v."value" FROM "PostVote" v
            JOIN eligible e ON e."id" = v."post_id" JOIN "User" u ON u."id" = v."user_id"
            WHERE v."updated_at" >= (now() AT TIME ZONE 'UTC') - interval '${TRENDING.POST_WINDOW_HOURS} hours'
              AND v."user_id" <> e."author_id" AND ${TRUSTED('u')}
        ),
        replies AS (
            SELECT DISTINCT cm."post_id", cm."author_id" AS user_id FROM "Comment" cm
            JOIN eligible e ON e."id" = cm."post_id" JOIN "User" u ON u."id" = cm."author_id"
            WHERE cm."created_at" >= (now() AT TIME ZONE 'UTC') - interval '${TRENDING.POST_WINDOW_HOURS} hours'
              AND cm."status" IN ('active', 'locked') AND NOT cm."shadow_hidden"
              AND cm."author_id" <> e."author_id" AND ${TRUSTED('u')}
        ),
        counts AS (
            SELECT e."id", e."created_at",
                   (SELECT count(*) FILTER (WHERE "value" = 1) - count(*) FILTER (WHERE "value" = -1) FROM votes v WHERE v."post_id" = e."id") AS net_votes,
                   (SELECT count(*) FROM votes v WHERE v."post_id" = e."id") AS voters,
                   (SELECT count(*) FROM replies r WHERE r."post_id" = e."id") AS repliers,
                   (SELECT count(*) FROM (
                        SELECT "user_id" FROM votes v WHERE v."post_id" = e."id" AND v."value" = 1
                        UNION SELECT "user_id" FROM replies r WHERE r."post_id" = e."id") people) AS people
            FROM eligible e
        )
        SELECT "id" AS post_id, "voters", "repliers",
               (net_votes + ${TRENDING.REPLY_WEIGHT} * repliers)
                   / power(extract(epoch FROM (now() AT TIME ZONE 'UTC') - "created_at") / 3600 + 2, ${TRENDING.GRAVITY}) AS score
        FROM counts
        WHERE people >= ${TRENDING.MIN_POST_PEOPLE} AND net_votes + ${TRENDING.REPLY_WEIGHT} * repliers >= ${TRENDING.MIN_POST_ENGAGEMENT}
        ORDER BY score DESC, "created_at" DESC
        LIMIT ${TRENDING.KEEP}`);
    return rows.map((row) => ({ ...row, score: Number(row.score), voters: Number(row.voters), repliers: Number(row.repliers) }));
}

type RisingCommunityRow = { community_id: string; score: number; new_members: number; posts: number; comments: number };

export async function scoreRisingCommunities(): Promise<RisingCommunityRow[]> {
    const since = `(now() AT TIME ZONE 'UTC') - interval '${TRENDING.COMMUNITY_WINDOW_DAYS} days'`;
    const rows = await prisma.$queryRawUnsafe<{ community_id: string; score: number; new_members: bigint; posts: bigint; comments: bigint }[]>(`
        WITH eligible AS (
            SELECT c."id", c."member_count" FROM "Community" c
            WHERE c."status" = 'active' AND c."visibility" = 'public' AND NOT c."is_nsfw"
        ),
        joins AS (
            SELECT m."community_id", m."user_id" FROM "CommunityMember" m JOIN eligible e ON e."id" = m."community_id"
            JOIN "User" u ON u."id" = m."user_id"
            WHERE m."joined_at" >= ${since} AND NOT m."is_banned" AND ${TRUSTED('u')}
        ),
        posts AS (
            SELECT p."community_id", p."author_id" AS user_id FROM "Post" p JOIN "Community" c ON c."id" = p."community_id"
            JOIN "User" u ON u."id" = p."author_id"
            WHERE p."created_at" >= ${since} AND ${PUBLIC_POST} AND ${TRUSTED('u')}
        ),
        comments AS (
            SELECT p."community_id", cm."author_id" AS user_id FROM "Comment" cm JOIN "Post" p ON p."id" = cm."post_id"
            JOIN "Community" c ON c."id" = p."community_id" JOIN "User" u ON u."id" = cm."author_id"
            WHERE cm."created_at" >= ${since} AND cm."status" IN ('active', 'locked') AND NOT cm."shadow_hidden"
              AND ${PUBLIC_POST} AND ${TRUSTED('u')}
        ),
        counts AS (
            SELECT e."id", e."member_count",
                   (SELECT count(*) FROM joins j WHERE j."community_id" = e."id") AS new_members,
                   (SELECT count(*) FROM posts p WHERE p."community_id" = e."id") AS posts,
                   (SELECT count(*) FROM comments c WHERE c."community_id" = e."id") AS comments,
                   (SELECT count(*) FROM (
                        SELECT "user_id" FROM joins j WHERE j."community_id" = e."id"
                        UNION SELECT "user_id" FROM posts p WHERE p."community_id" = e."id"
                        UNION SELECT "user_id" FROM comments c WHERE c."community_id" = e."id") people) AS people
            FROM eligible e
        )
        SELECT "id" AS community_id, new_members, posts, comments,
               (new_members + 2 * posts + comments) / sqrt("member_count" + ${TRENDING.COMMUNITY_SIZE_OFFSET}) AS score
        FROM counts
        WHERE people >= ${TRENDING.MIN_COMMUNITY_PEOPLE} AND new_members + posts + comments > 0
        ORDER BY score DESC, "member_count" DESC
        LIMIT ${TRENDING.KEEP}`);
    return rows.map((row) => ({
        community_id: row.community_id,
        score: Number(row.score),
        new_members: Number(row.new_members),
        posts: Number(row.posts),
        comments: Number(row.comments),
    }));
}

// Titles for topic extraction: the last 3 days, and the 30 days before as the baseline of what's always talked about
export const TOPIC_WINDOW_DAYS = 3;
export const TOPIC_BASELINE_DAYS = 30;

async function recentTitles(fromDays: number, toDays: number, limit: number) {
    return prisma.$queryRawUnsafe<TitleRow[]>(`
        SELECT p."id", p."title", p."author_id", p."community_id", c."name" AS community, f."name" AS flair
        FROM "Post" p JOIN "Community" c ON c."id" = p."community_id"
        LEFT JOIN "Flair" f ON f."id" = p."flair_id"
        JOIN "User" u ON u."id" = p."author_id"
        WHERE p."created_at" >= (now() AT TIME ZONE 'UTC') - interval '${fromDays} days'
          AND p."created_at" < (now() AT TIME ZONE 'UTC') - interval '${toDays} days'
          AND ${PUBLIC_POST} AND ${TRUSTED('u')}
        ORDER BY p."created_at" DESC
        LIMIT ${limit}`);
}

export async function scoreTopics() {
    const [recent, baseline] = await Promise.all([
        recentTitles(TOPIC_WINDOW_DAYS, 0, 5000),
        recentTitles(TOPIC_WINDOW_DAYS + TOPIC_BASELINE_DAYS, TOPIC_WINDOW_DAYS, 20000),
    ]);
    return extractTopics(recent, baseline, { windowDays: TOPIC_WINDOW_DAYS, baselineDays: TOPIC_BASELINE_DAYS });
}

// The word list behind "Did you mean ...?": every word in visible titles and community names, with how many
// titles use it. ts_stat over the 'simple' configuration keeps words as typed (lowercased, not stemmed).
export async function refreshSearchWords() {
    await prisma.$transaction([
        prisma.$executeRaw`DELETE FROM "SearchWord"`,
        prisma.$executeRaw`
            INSERT INTO "SearchWord" ("word", "docs")
            SELECT word, sum(ndoc)::int FROM (
                SELECT word, ndoc FROM ts_stat($$
                    SELECT to_tsvector('simple', p."title") FROM "Post" p JOIN "Community" c ON c."id" = p."community_id"
                    WHERE p."status" IN ('active', 'locked') AND NOT p."shadow_hidden" AND c."status" = 'active' AND c."visibility" = 'public'
                $$)
                UNION ALL
                SELECT word, ndoc FROM ts_stat($$
                    SELECT to_tsvector('simple', replace("name", '_', ' ') || ' ' || coalesce("display_name", ''))
                    FROM "Community" WHERE "status" = 'active' AND "visibility" = 'public'
                $$)
            ) words
            WHERE length(word) BETWEEN 3 AND 30 AND word ~ '^[[:alpha:]]+$'
            GROUP BY word
            ORDER BY 2 DESC
            LIMIT 50000`,
    ]);
}

let searchWordsAt = 0;
const SEARCH_WORDS_EVERY_MS = 60 * 60 * 1000;

// Recomputes every snapshot and swaps each table's contents in one transaction. An advisory lock keeps two API
// instances (or the job and a lazy refresh) from writing at the same time; the loser just skips.
export async function computeTrending() {
    const started = Date.now();
    const [posts, communities, topics] = await Promise.all([scoreTrendingPosts(), scoreRisingCommunities(), scoreTopics()]);
    const now = new Date();

    const wrote = await prisma.$transaction(async (tx) => {
        const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('trending')) AS locked`;
        if (!lock.locked) return false;
        await tx.$executeRaw`DELETE FROM "TrendingPost"`;
        await tx.$executeRaw`DELETE FROM "TrendingCommunity"`;
        await tx.$executeRaw`DELETE FROM "TrendingTopic"`;
        if (posts.length) {
            await tx.trendingPost.createMany({ data: posts.map((row, index) => ({ ...row, rank: index + 1, computed_at: now })) });
        }
        if (communities.length) {
            await tx.trendingCommunity.createMany({ data: communities.map((row, index) => ({ ...row, rank: index + 1, computed_at: now })) });
        }
        if (topics.length) {
            await tx.trendingTopic.createMany({
                data: topics.map((topic, index) => ({
                    rank: index + 1,
                    kind: topic.kind,
                    term: topic.term,
                    community_id: topic.community_id,
                    posts: topic.posts,
                    authors: topic.authors,
                    score: topic.score,
                    computed_at: now,
                })),
            });
        }
        return true;
    });

    if (wrote && Date.now() - searchWordsAt > SEARCH_WORDS_EVERY_MS) {
        searchWordsAt = Date.now();
        await refreshSearchWords().catch((error) => logger.warn({ err: error }, 'Search words refresh failed'));
    }
    lastComputedAt = Date.now();
    logger.info({ posts: posts.length, communities: communities.length, topics: topics.length, ms: Date.now() - started }, 'Trending computed');
}

// Without the job queue (JOBS_ENABLED=false) nothing recomputes on a schedule, so readers refresh a stale snapshot
// themselves: the first read in this process waits for it, later ones get the current snapshot while a refresh
// runs in the background. With the queue on this rarely triggers.
export const TRENDING_STALE_MS = 10 * 60 * 1000;
let lastComputedAt = 0;
let computing: Promise<void> | null = null;

export function refreshTrending() {
    computing ??= computeTrending()
        .catch((error) => logger.error({ err: error }, 'Trending computation failed'))
        .finally(() => {
            computing = null;
        });
    return computing;
}

export async function ensureFreshTrending() {
    if (Date.now() - lastComputedAt < TRENDING_STALE_MS) return;
    const [row] = await prisma.$queryRaw<{ at: Date | null }[]>`
        SELECT greatest(
            (SELECT max("computed_at") FROM "TrendingPost"),
            (SELECT max("computed_at") FROM "TrendingCommunity"),
            (SELECT max("computed_at") FROM "TrendingTopic")) AS at`;
    // computed_at is written by Prisma (UTC); another instance or the scheduled job may have run it recently
    if (row.at && Date.now() - row.at.getTime() < TRENDING_STALE_MS) {
        lastComputedAt = row.at.getTime();
        return;
    }
    const pending = refreshTrending();
    if (!row.at && lastComputedAt === 0) await pending;
}

// Tests compute on demand
export function resetTrendingForTests() {
    lastComputedAt = 0;
    searchWordsAt = 0;
}
