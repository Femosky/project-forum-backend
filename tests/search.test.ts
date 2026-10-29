import { describe, expect, it } from 'vitest';
import { api, createComment, createCommunity, createPost, signUp } from './helpers';
import prisma from '../src/prismaConnection';
import { refreshSearchWords } from '../src/modules/trending/service';

describe('search', () => {
    it('finds posts by title and body, best match first, skipping private communities', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        await createCommunity(alice.agent, 'secret', { visibility: 'private' });
        await createPost(alice.agent, 'lounge', { title: 'Renting a flat in Yaba', body: 'Agents keep asking for two years upfront.' });
        await createPost(alice.agent, 'lounge', { title: 'Best suya spots', body: 'Mentioned renting once.' });
        await createPost(alice.agent, 'lounge', { title: 'Unrelated', body: 'Nothing to see here.' });
        await createPost(alice.agent, 'secret', { title: 'Secret renting tips', body: 'hidden' });

        const results = await api().get('/v1/search?q=renting');
        expect(results.body.posts.map((p: { title: string }) => p.title)).toEqual(['Renting a flat in Yaba', 'Best suya spots']);
        expect((await api().get('/v1/search?q=x')).status).toBe(400);
    });

    it('finds communities and autocompletes names', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lagos_rent', { description: 'Housing and rent in Lagos' });
        await createCommunity(alice.agent, 'london_naija', { description: 'Nigerians in London' });

        const found = await api().get('/v1/search?type=communities&q=housing');
        expect(found.body.communities.map((c: { name: string }) => c.name)).toEqual(['lagos_rent']);

        const complete = await api().get('/v1/search/autocomplete?q=l');
        expect(complete.body.communities.map((c: { name: string }) => c.name).sort()).toEqual(['lagos_rent', 'london_naija']);
        expect((await api().get('/v1/search/autocomplete?q=lo')).body.communities.map((c: { name: string }) => c.name)).toEqual(['london_naija']);
        expect((await api().get('/v1/search/autocomplete?q=ali')).body.users.map((u: { username: string }) => u.username)).toEqual(['alice']);
        // Spaces stand for underscores, and any word in the name can start the match
        const names = async (q: string) =>
            (await api().get(`/v1/search/autocomplete?q=${encodeURIComponent(q)}`)).body.communities.map((c: { name: string }) => c.name);
        expect(await names('lagos r')).toEqual(['lagos_rent']);
        expect(await names('rent')).toEqual(['lagos_rent']);
        expect(await names('naija')).toEqual(['london_naija']);
        expect(await names('ent')).toEqual([]);
        // LIKE wildcards in the query are treated literally
        expect((await api().get('/v1/search/autocomplete?q=%25')).body.communities).toEqual([]);
    });

    it('searches comments with the same visibility rules, linking back to their thread', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        await createCommunity(alice.agent, 'secret', { visibility: 'private' });
        const post = await createPost(alice.agent, 'lounge', { title: 'Where to eat' });
        const hiddenPost = await createPost(alice.agent, 'secret', { title: 'Private chat' });
        const visible = await createComment(bob.agent, post.id, { body: 'Try the amala spot in Bodija', is_anonymous: true });
        await createComment(alice.agent, hiddenPost.id, { body: 'Secret amala recipe' });
        const removed = await createComment(bob.agent, post.id, { body: 'Amala is overrated, fight me' });
        await alice.agent.post(`/v1/comments/${removed.id}/moderation`).send({ action: 'remove' });

        const found = await api().get('/v1/search?type=comments&q=amala');
        expect(found.status).toBe(200);
        expect(found.body.comments.map((comment: { id: string }) => comment.id)).toEqual([visible.id]);
        expect(found.body.comments[0].post).toEqual({ short_id: post.short_id, slug: expect.any(String), title: 'Where to eat', community: 'lounge' });
        // Anonymous stays anonymous
        expect(found.body.comments[0].author).toBeNull();
    });

    it('searches inside one community', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        await createCommunity(alice.agent, 'jobs');
        await createCommunity(alice.agent, 'secret', { visibility: 'private' });
        await createPost(alice.agent, 'lounge', { title: 'Remote work in Lagos', body: 'lounge' });
        await createPost(alice.agent, 'jobs', { title: 'Remote work openings', body: 'jobs' });

        const titles = async (query: string) =>
            (await api().get(`/v1/search?${query}`)).body.posts.map((post: { title: string }) => post.title);
        expect(await titles('q=remote')).toHaveLength(2);
        expect(await titles('q=remote&community=jobs')).toEqual(['Remote work openings']);
        expect(await titles('q=remote&community=secret')).toEqual([]);
        expect(await titles('q=remote&community=nowhere')).toEqual([]);
    });

    it('suggests a spelling and similar community names when little is found', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lagos_rent', { description: 'Housing' });
        await createPost(alice.agent, 'lagos_rent', { title: 'Landlord wants two years upfront', body: 'help' });
        await refreshSearchWords();
        expect(await prisma.searchWord.count()).toBeGreaterThan(3);

        const typo = await api().get('/v1/search?q=landlrod');
        expect(typo.body.posts).toEqual([]);
        expect(typo.body.did_you_mean).toBe('landlord');
        expect((await api().get('/v1/search?q=landlrod upfrnt')).body.did_you_mean).toBe('landlord upfront');
        // Nothing to suggest for words that are fine, or gibberish
        expect((await api().get('/v1/search?q=landlord')).body.did_you_mean).toBeNull();
        expect((await api().get('/v1/search?q=zzqxv')).body.did_you_mean).toBeNull();

        const fuzzy = await api().get('/v1/search?q=lagos rnt');
        expect(fuzzy.body.related_communities.map((community: { name: string }) => community.name)).toEqual(['lagos_rent']);
        const communities = await api().get('/v1/search?type=communities&q=lagos rnt');
        expect(communities.body.communities.map((community: { name: string }) => community.name)).toEqual(['lagos_rent']);
    });
});
