import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { api, createComment, createCommunity, createPost, signUp } from './helpers';

const LONG_BODY = 'Agents keep asking for two years upfront, is that normal everywhere?';

// Test accounts are seconds old; age one so its posts aren't held back as "brand-new account" posts
async function ageAccount(userId: string) {
    await prisma.user.update({ where: { id: userId }, data: { created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } });
}

describe('indexing rule', () => {
    it('holds back posts by brand-new accounts until they get a reply or an upvote', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge', { title: 'Renting a flat in Yaba', body: LONG_BODY });

        expect((await api().get(`/v1/posts/${post.short_id}`)).body.post.is_indexable).toBe(false);
        await bob.agent.put(`/v1/posts/${post.id}/vote`).send({ value: 1 });
        expect((await api().get(`/v1/posts/${post.short_id}`)).body.post.is_indexable).toBe(true);
    });

    it('holds back very short posts with no replies, and removed posts', async () => {
        const alice = await signUp('alice');
        await ageAccount(alice.user.id);
        await createCommunity(alice.agent, 'lounge');
        const short = await createPost(alice.agent, 'lounge', { title: 'Hello', body: 'hi' });
        const good = await createPost(alice.agent, 'lounge', { title: 'Renting a flat in Yaba', body: LONG_BODY });

        expect((await api().get(`/v1/posts/${short.short_id}`)).body.post.is_indexable).toBe(false);
        await createComment(alice.agent, short.id, { body: 'Welcome!' });
        expect((await api().get(`/v1/posts/${short.short_id}`)).body.post.is_indexable).toBe(true);

        expect((await api().get(`/v1/posts/${good.short_id}`)).body.post.is_indexable).toBe(true);
        await prisma.post.update({ where: { id: good.id }, data: { status: 'removed' } });
        expect((await alice.agent.get(`/v1/posts/${good.short_id}`)).body.post.is_indexable).toBe(false);
    });
});

describe('sitemap data', () => {
    it('lists indexable posts, public communities and users with indexable posts', async () => {
        const alice = await signUp('alice');
        const newbie = await signUp('newbie');
        await ageAccount(alice.user.id);
        await createCommunity(alice.agent, 'lounge');
        await createCommunity(alice.agent, 'secret', { visibility: 'private' });

        const listed = await createPost(alice.agent, 'lounge', { title: 'Renting a flat in Yaba', body: LONG_BODY });
        await createPost(alice.agent, 'secret', { title: 'Private thoughts on rent', body: LONG_BODY });
        await createPost(alice.agent, 'lounge', { title: 'Anon post about rent', body: LONG_BODY, is_anonymous: true });
        await createPost(newbie.agent, 'lounge', { title: 'New account post about rent', body: LONG_BODY });

        const index = await api().get('/v1/seo/sitemap');
        expect(index.status).toBe(200);
        expect(index.body.posts).toHaveLength(1);
        expect(index.body.posts[0].page).toBe(1);
        expect(index.body.communities).toHaveLength(1);
        expect(index.body.users).toHaveLength(1);

        const posts = await api().get('/v1/seo/sitemap/posts/1');
        expect(posts.body.urls.map((url: { short_id: string }) => url.short_id)).toHaveLength(2);
        expect(posts.body.urls[0]).toMatchObject({ community: 'lounge', short_id: listed.short_id, slug: 'renting-a-flat-in-yaba' });
        expect(posts.body.urls[0].lastmod).toBeTruthy();

        const communities = await api().get('/v1/seo/sitemap/communities/1');
        expect(communities.body.urls.map((url: { name: string }) => url.name)).toEqual(['lounge']);

        // Only alice: her one public, named post counts; newbie's post is still held back
        const users = await api().get('/v1/seo/sitemap/users/1');
        expect(users.body.urls.map((url: { username: string }) => url.username)).toEqual(['alice']);

        expect((await api().get('/v1/seo/sitemap/posts/2')).status).toBe(404);
        expect((await api().get('/v1/seo/sitemap/other/1')).status).toBe(400);
    });
});

describe('related posts', () => {
    it('finds threads sharing title words and more from the same community', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        await createCommunity(alice.agent, 'money');
        await createCommunity(alice.agent, 'secret', { visibility: 'private' });

        const post = await createPost(alice.agent, 'lounge', { title: 'Renting a flat in Yaba', body: LONG_BODY });
        await createPost(alice.agent, 'money', { title: 'Is renting cheaper than buying?', body: 'Numbers please.' });
        await createPost(alice.agent, 'secret', { title: 'Renting secrets', body: 'hidden' });
        await createPost(alice.agent, 'lounge', { title: 'Best suya spots', body: 'Go.' });

        const response = await api().get(`/v1/posts/${post.short_id}/related`);
        expect(response.status).toBe(200);
        expect(response.body.related.map((row: { title: string }) => row.title)).toEqual(['Is renting cheaper than buying?']);
        expect(response.body.related[0].community).toBe('money');
        expect(response.body.more_from_community.map((row: { title: string }) => row.title)).toEqual(['Best suya spots']);
        expect(response.body.more_from_community[0]).toMatchObject({ community: 'lounge', slug: 'best-suya-spots' });
    });
});
