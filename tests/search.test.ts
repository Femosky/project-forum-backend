import { describe, expect, it } from 'vitest';
import { api, createCommunity, createPost, signUp } from './helpers';

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
        // LIKE wildcards in the query are treated literally
        expect((await api().get('/v1/search/autocomplete?q=%25')).body.communities).toEqual([]);
    });
});
