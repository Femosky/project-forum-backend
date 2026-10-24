import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { api, createComment, createCommunity, createPost, signUp } from './helpers';

const LONG_BODY = 'Agents keep asking for two years upfront, is that normal everywhere?';


describe('indexing rule', () => {
    it('holds back posts by brand-new accounts until they get a reply or an upvote', async () => {
        const alice = await signUp('alice', { fresh: true });
        const bob = await signUp('bob');
        await createCommunity(bob.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge', { title: 'Renting a flat in Yaba', body: LONG_BODY });

        expect((await api().get(`/v1/posts/${post.short_id}`)).body.post.is_indexable).toBe(false);
        await bob.agent.put(`/v1/posts/${post.id}/vote`).send({ value: 1 });
        expect((await api().get(`/v1/posts/${post.short_id}`)).body.post.is_indexable).toBe(true);
    });

    it('holds back very short posts with no replies, and removed posts', async () => {
        const alice = await signUp('alice');
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
        const newbie = await signUp('newbie', { fresh: true });
        await createCommunity(alice.agent, 'lounge');
        await createCommunity(alice.agent, 'secret', { visibility: 'private' });

        const listed = await createPost(alice.agent, 'lounge', { title: 'Renting a flat in Yaba', body: LONG_BODY });
        // A different body: the same text in two communities would be held as a repeat
        await createPost(alice.agent, 'secret', { title: 'Private thoughts on rent', body: `${LONG_BODY} Asking privately.` });
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

describe('page status for crawlers', () => {
    it('gives canonical paths for live pages, gone for deleted ones and missing for unknown or private', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        await createCommunity(alice.agent, 'secret', { visibility: 'private' });
        const post = await createPost(alice.agent, 'lounge', { title: 'Renting a flat in Yaba', body: LONG_BODY });
        const hidden = await createPost(alice.agent, 'secret', { title: 'Hidden', body: LONG_BODY });

        const status = (query: string) => api().get(`/v1/seo/status?${query}`).then((response) => response.body);

        expect(await status(`type=post&id=${post.short_id.toUpperCase()}`)).toEqual({ state: 'live', path: `/c/lounge/${post.short_id}/renting-a-flat-in-yaba` });
        expect(await status(`type=post&id=${hidden.short_id}`)).toEqual({ state: 'missing' });
        expect(await status('type=post&id=nothere1')).toEqual({ state: 'missing' });
        await alice.agent.delete(`/v1/posts/${post.id}`);
        expect(await status(`type=post&id=${post.short_id}`)).toEqual({ state: 'gone' });

        expect(await status('type=community&id=Lounge')).toEqual({ state: 'live', path: '/c/lounge' });
        expect(await status('type=community&id=nope')).toEqual({ state: 'missing' });
        expect(await status('type=user&id=alice')).toEqual({ state: 'live', path: '/u/alice' });
        await prisma.user.update({ where: { id: alice.user.id }, data: { status: 'deleted' } });
        expect(await status('type=user&id=alice')).toEqual({ state: 'gone' });
        expect((await api().get('/v1/seo/status?type=thing&id=x')).status).toBe(400);
    });
});
