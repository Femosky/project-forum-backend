import { describe, expect, it } from 'vitest';
import { urlKey } from '../src/lib/urls';
import { api, createCommunity, createPost, signUp } from './helpers';

describe('links', () => {
    it('gives the same key to the same page with different tracking and formatting', () => {
        expect(urlKey('https://www.Example.com/a/?utm_source=x&b=2&a=1#top')).toBe('example.com/a?a=1&b=2');
        expect(urlKey('http://example.com/a?b=2&a=1')).toBe('example.com/a?a=1&b=2');
        expect(urlKey('ftp://example.com')).toBeNull();
        expect(urlKey('not a url')).toBeNull();
    });

    it('finds earlier posts of the same link in public communities only', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        await createCommunity(alice.agent, 'hideout', { visibility: 'private' });
        await createPost(alice.agent, 'lounge', { type: 'link', url: 'https://example.com/story?utm_campaign=x', title: 'Story' });
        await createPost(alice.agent, 'hideout', { type: 'link', url: 'https://example.com/story', title: 'Secret copy' });

        const found = await api().get('/v1/posts/duplicates').query({ url: 'https://www.example.com/story/' });
        expect(found.status).toBe(200);
        expect(found.body.posts.map((post: { title: string }) => post.title)).toEqual(['Story']);
        expect((await api().get('/v1/posts/duplicates').query({ url: 'https://example.com/other' })).body.posts).toEqual([]);
    });

    it('only previews links for signed-in users and rejects non-links', async () => {
        expect((await api().get('/v1/posts/link-preview').query({ url: 'https://example.com' })).status).toBe(401);
        const alice = await signUp('alice');
        expect((await alice.agent.get('/v1/posts/link-preview').query({ url: 'javascript:alert(1)' })).status).toBe(400);
    });
});
