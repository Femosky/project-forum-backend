import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { hotRank } from '../src/lib/ranking';
import { computeTrending, scoreRisingCommunities, scoreTrendingPosts } from '../src/modules/trending/service';
import { extractTopics, termKey, tokenize, TitleRow } from '../src/modules/trending/topics';
import { api, Agent, createComment, createCommunity, createPost, signUp } from './helpers';

const HOUR = 60 * 60 * 1000;

async function people(prefix: string, count: number) {
    return Promise.all(Array.from({ length: count }, (_, index) => signUp(`${prefix}${index}`)));
}

const vote = (agent: Agent, postId: string, value = 1) => agent.put(`/v1/posts/${postId}/vote`).send({ value });

describe('hot rank with replies', () => {
    it('matches the SQL function and moves when comments come and go', async () => {
        const [row] = await prisma.$queryRaw<{ rank: number }[]>`
            SELECT forum_hot_rank(7, 12, '2026-10-20 08:30:00'::timestamp) AS rank`;
        expect(row.rank).toBeCloseTo(hotRank(7, new Date('2026-10-20T08:30:00Z'), 12), 6);

        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        const rankOf = async () => (await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).hot_rank;
        const before = await rankOf();

        const comments = [];
        for (let index = 0; index < 4; index++) comments.push(await createComment(bob.agent, post.id, { body: `reply ${index}` }));
        const stored = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
        expect(stored.hot_rank).toBeGreaterThan(before);
        expect(stored.hot_rank).toBeCloseTo(hotRank(0, stored.created_at, 4), 5);

        // Votes keep the replies in the rank
        await vote(bob.agent, post.id);
        expect(await rankOf()).toBeCloseTo(hotRank(1, stored.created_at, 4), 5);

        // Deleting a reply takes it back out
        await bob.agent.delete(`/v1/comments/${comments[0].id}`);
        expect(await rankOf()).toBeCloseTo(hotRank(1, stored.created_at, 3), 5);
    });
});

describe('trending posts', () => {
    it('ranks recent engagement by distinct people, with thresholds and safety filters', async () => {
        const owner = await signUp('owner');
        const crowd = await people('fan', 4);
        await createCommunity(owner.agent, 'football');
        await createCommunity(owner.agent, 'secret', { visibility: 'private' });

        const busy = await createPost(owner.agent, 'football', { title: 'Super Eagles squad announced' });
        const quiet = await createPost(owner.agent, 'football', { title: 'Boots for sale' });
        const spicy = await createPost(owner.agent, 'football', { title: 'Locker room photos', is_nsfw: true });
        const hidden = await createPost(owner.agent, 'secret', { title: 'Private match chat' });
        for (const fan of crowd) {
            await vote(fan.agent, busy.id);
            await createComment(fan.agent, busy.id, { body: `Big squad news from ${fan.user.username}` });
            await vote(fan.agent, spicy.id);
        }
        // Two people isn't a trend
        await vote(crowd[0].agent, quiet.id);
        await vote(crowd[1].agent, quiet.id);
        await prisma.post.update({ where: { id: hidden.id }, data: { upvote_count: 50, score: 50 } });

        const ranked = await scoreTrendingPosts();
        expect(ranked.map((row) => row.post_id)).toEqual([busy.id]);
        expect(ranked[0]).toMatchObject({ voters: 4, repliers: 4 });
    });

    it("doesn't let one account pump a post, and ignores old posts and shadow-banned or brand-new accounts", async () => {
        const owner = await signUp('owner');
        const pumper = await signUp('pumper');
        const shadow = await signUp('shadow');
        const fresh = await signUp('fresh', { fresh: true });
        const friend = await signUp('friend');
        await createCommunity(owner.agent, 'music');
        const post = await createPost(owner.agent, 'music', { title: 'Afrobeats album of the year' });

        for (let index = 0; index < 10; index++) await createComment(pumper.agent, post.id, { body: `Pumping reply number ${index}` });
        await vote(pumper.agent, post.id);
        await prisma.user.update({ where: { id: shadow.user.id }, data: { shadow_banned_at: new Date() } });
        await vote(shadow.agent, post.id);
        await vote(fresh.agent, post.id);
        await vote(friend.agent, post.id);
        // Only pumper and friend count: two people
        expect(await scoreTrendingPosts()).toEqual([]);

        const more = await people('real', 2);
        for (const person of more) await vote(person.agent, post.id);
        expect((await scoreTrendingPosts()).map((row) => row.post_id)).toEqual([post.id]);

        // Over a week old: out, however busy
        await prisma.post.update({ where: { id: post.id }, data: { created_at: new Date(Date.now() - 8 * 24 * HOUR) } });
        expect(await scoreTrendingPosts()).toEqual([]);
    });

    it('decays with age and drops removed posts on read', async () => {
        const owner = await signUp('owner');
        const crowd = await people('fan', 3);
        await createCommunity(owner.agent, 'news');
        const older = await createPost(owner.agent, 'news', { title: 'Fuel price update from yesterday' });
        const newer = await createPost(owner.agent, 'news', { title: 'Election results are coming in' });
        await prisma.post.update({ where: { id: older.id }, data: { created_at: new Date(Date.now() - 30 * HOUR) } });
        for (const fan of crowd) {
            await vote(fan.agent, older.id);
            await vote(fan.agent, newer.id);
        }

        await computeTrending();
        const listed = await api().get('/v1/trending?type=posts');
        expect(listed.status).toBe(200);
        expect(listed.body.posts.map((post: { id: string }) => post.id)).toEqual([newer.id, older.id]);
        expect(listed.body.computed_at).toBeTruthy();

        await owner.agent.post(`/v1/posts/${newer.id}/moderation`).send({ action: 'remove' });
        expect((await api().get('/v1/trending?type=posts')).body.posts.map((post: { id: string }) => post.id)).toEqual([older.id]);
        expect((await api().get('/v1/trending?type=nonsense')).status).toBe(400);
    });

    it('computes a snapshot on first read when none exists', async () => {
        const owner = await signUp('owner');
        const crowd = await people('fan', 3);
        await createCommunity(owner.agent, 'lounge');
        const post = await createPost(owner.agent, 'lounge', { title: 'Weekend plans in Abuja' });
        for (const fan of crowd) await vote(fan.agent, post.id);

        const listed = await api().get('/v1/trending?type=posts');
        expect(listed.body.posts.map((item: { id: string }) => item.id)).toEqual([post.id]);
        expect(await prisma.trendingPost.count()).toBe(1);
    });
});

describe('rising communities', () => {
    it('normalises growth by size so a small fast-growing community can lead', async () => {
        const owner = await signUp('owner');
        await createCommunity(owner.agent, 'bigclub');
        await createCommunity(owner.agent, 'tinyclub');
        await createCommunity(owner.agent, 'nsfwclub', { is_nsfw: true });
        const big = await prisma.community.update({ where: { name: 'bigclub' }, data: { member_count: 5000 } });

        const crowd = await people('member', 4);
        for (const person of crowd) {
            await person.agent.put('/v1/communities/tinyclub/membership');
            await person.agent.put('/v1/communities/bigclub/membership');
            await person.agent.put('/v1/communities/nsfwclub/membership');
        }
        await createPost(crowd[0].agent, 'bigclub', { title: 'Big club weekly thread' });
        await createPost(crowd[1].agent, 'bigclub', { title: 'Big club match day' });

        const ranked = await scoreRisingCommunities();
        const tiny = await prisma.community.findUniqueOrThrow({ where: { name: 'tinyclub' } });
        expect(ranked.map((row) => row.community_id)).toEqual([tiny.id, big.id]);
        // The creator's own join counts too
        expect(ranked[0]).toMatchObject({ new_members: 5, posts: 0 });

        await computeTrending();
        const listed = await api().get('/v1/trending?type=communities');
        expect(listed.body.communities.map((community: { name: string }) => community.name)).toEqual(['tinyclub', 'bigclub']);
        expect(listed.body.communities[0].trending).toEqual({ new_members: 5, posts: 0, comments: 0 });
    });
});

describe('trending topics', () => {
    const row = (id: number, title: string, author: string, flair: string | null = null): TitleRow => ({
        id: `p${id}`,
        title,
        author_id: author,
        community_id: 'c1',
        community: 'football',
        flair,
    });

    it('tokenizes titles, dropping stopwords and folding plurals', () => {
        expect(tokenize("Who's watching the BBNaija finale tonight?")).toEqual([null, 'watching', null, 'bbnaija', 'finale', 'tonight']);
        expect(tokenize('The 2027 elections and 12 polls')).toEqual([null, '2027', 'elections', null, null, 'polls']);
        expect(termKey('elections')).toBe('election');
        expect(termKey('business')).toBe('business');
    });

    it('needs several authors, prefers phrases over their words and skips always-common terms', () => {
        const recent = [
            row(1, 'Super Eagles squad for the qualifiers', 'a'),
            row(2, 'Super Eagles coach under pressure', 'b'),
            row(3, 'Can the Super Eagles win on Saturday?', 'c'),
            row(4, 'Lagos rent is mad this year', 'a'),
            row(5, 'Lagos traffic on Third Mainland', 'b'),
            row(6, 'Moving to Lagos next month', 'c'),
            row(7, 'Election results: who won Lagos?', 'a'),
            row(8, 'Election day experience', 'a'),
        ];
        // Lagos comes up every day; Super Eagles doesn't
        const baseline = Array.from({ length: 300 }, (_, index) => ({ title: index % 2 ? 'Lagos landlords again' : 'Cooking jollof at home' }));
        const topics = extractTopics(recent, baseline, { windowDays: 3, baselineDays: 30 });
        const terms = topics.filter((topic) => topic.kind === 'term').map((topic) => topic.term);
        expect(terms[0]).toBe('super eagles');
        expect(terms).not.toContain('super');
        expect(terms).not.toContain('eagles');
        // One author twice isn't a topic
        expect(terms).not.toContain('election');
        expect(terms.indexOf('lagos')).toBeGreaterThan(terms.indexOf('super eagles'));
        expect(topics.find((topic) => topic.term === 'super eagles')).toMatchObject({ posts: 3, authors: 3 });
    });

    it('surfaces busy flairs with their community', () => {
        const recent = [row(1, 'Done deal', 'a', 'Transfer news'), row(2, 'Medical booked', 'b', 'Transfer news'), row(3, 'Fee agreed', 'c', 'Transfer news')];
        const topics = extractTopics(recent, [], { windowDays: 3, baselineDays: 30 });
        expect(topics.filter((topic) => topic.kind === 'flair')).toEqual([
            expect.objectContaining({ term: 'Transfer news', community: 'football', posts: 3, authors: 3 }),
        ]);
    });

    it('serves topics from recent public titles through the API', async () => {
        const owner = await signUp('owner');
        const crowd = await people('fan', 3);
        await createCommunity(owner.agent, 'tvshows');
        await createCommunity(owner.agent, 'hidden', { visibility: 'private' });
        for (const [index, fan] of crowd.entries()) {
            await createPost(fan.agent, 'tvshows', { title: `BBNaija eviction night thoughts ${index}`, body: `Body ${index}` });
            await createPost(owner.agent, 'hidden', { title: `Secret garden party ${index}`, body: `Hidden ${index}` });
        }
        await computeTrending();
        const listed = await api().get('/v1/trending?type=topics');
        const terms = listed.body.topics.map((topic: { term: string }) => topic.term);
        expect(terms[0]).toBe('bbnaija eviction');
        expect(terms.join(' ')).not.toContain('garden');
    });
});
