import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { hotRank } from '../src/lib/ranking';
import { api, createComment, createCommunity, createPost, makeModerator, signUp } from './helpers';

// Regression tests for roadmap bugs 2, 8 and 9

describe('anonymous content (bug 2)', () => {
    it('never exposes the author of anonymous posts and comments to the public', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge', { title: 'secret', is_anonymous: true });
        await createComment(alice.agent, post.id, { body: 'anon comment', is_anonymous: true });

        const responses = [
            await api().get('/v1/feed'),
            await api().get('/v1/communities/lounge/posts'),
            await api().get(`/v1/posts/${post.short_id}`),
            await api().get(`/v1/posts/${post.short_id}/comments`),
        ];
        for (const response of responses) {
            expect(response.status).toBe(200);
            expect(JSON.stringify(response.body)).not.toContain(alice.user.id);
            expect(JSON.stringify(response.body)).not.toContain('"alice"');
        }
        expect(responses[2].body.post.author).toBeNull();
        expect(responses[3].body.comments[0].author).toBeNull();
    });

    it('shows the author to themselves and to moderators, but not to other members', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        const carol = await signUp('carol');
        const community = await createCommunity(bob.agent, 'lounge');
        await makeModerator(bob.user.id, community.id);
        const post = await createPost(alice.agent, 'lounge', { is_anonymous: true });

        expect((await alice.agent.get(`/v1/posts/${post.id}`)).body.post.author.username).toBe('alice');
        expect((await bob.agent.get(`/v1/posts/${post.id}`)).body.post.author.username).toBe('alice');
        expect((await carol.agent.get(`/v1/posts/${post.id}`)).body.post.author).toBeNull();
    });

    it("leaves anonymous posts and comments off the author's public profile", async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge', { title: 'public' });
        await createPost(alice.agent, 'lounge', { title: 'secret', is_anonymous: true });
        await createComment(alice.agent, post.id, { body: 'named' });
        await createComment(alice.agent, post.id, { body: 'hidden', is_anonymous: true });

        const posts = await api().get('/v1/users/alice/posts');
        expect(posts.body.posts.map((p: { title: string }) => p.title)).toEqual(['public']);
        const comments = await api().get('/v1/users/alice/comments');
        expect(comments.body.comments.map((c: { body: string }) => c.body)).toEqual(['named']);
    });
});

describe('sorting (bug 8)', () => {
    it('applies new, top and hot sorts on indexed columns', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        const old = await createPost(alice.agent, 'lounge', { title: 'old but loved' });
        // 3 hours old with 10 net votes
        const createdAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
        await prisma.post.update({
            where: { id: old.id },
            data: { created_at: createdAt, upvote_count: 10, score: 10, hot_rank: hotRank(10, createdAt) },
        });
        const fresh = await createPost(alice.agent, 'lounge', { title: 'fresh' });
        await bob.agent.put(`/v1/posts/${fresh.id}/vote`).send({ value: 1 });

        const titles = async (query: string) =>
            (await api().get(`/v1/communities/lounge/posts?${query}`)).body.posts.map((p: { title: string }) => p.title);

        expect(await titles('sort=new')).toEqual(['fresh', 'old but loved']);
        expect(await titles('sort=top&t=day')).toEqual(['old but loved', 'fresh']);
        // 10x the votes is worth 12.5 hours of age, so the 3-hour-old post with 10 votes still leads
        expect(await titles('sort=hot')).toEqual(['old but loved', 'fresh']);
    });
});

describe('status filters (bug 9)', () => {
    it('hides removed, deleted and pending posts from lists and detail pages', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const visible = await createPost(alice.agent, 'lounge', { title: 'visible' });
        for (const status of ['removed', 'deleted', 'pending'] as const) {
            const post = await createPost(alice.agent, 'lounge', { title: status });
            await prisma.post.update({ where: { id: post.id }, data: { status } });
            expect((await api().get(`/v1/posts/${post.short_id}`)).status).toBe(404);
        }

        const list = await api().get('/v1/communities/lounge/posts');
        expect(list.body.posts.map((p: { title: string }) => p.title)).toEqual(['visible']);
        expect((await api().get(`/v1/posts/${visible.short_id}`)).status).toBe(200);
    });

    it('shows a deleted comment as a placeholder so its replies keep their place', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        const parent = await createComment(alice.agent, post.id, { body: 'will be deleted' });
        await createComment(bob.agent, post.id, { body: 'reply', parent_id: parent.id });
        await alice.agent.delete(`/v1/comments/${parent.id}`);

        const thread = await api().get(`/v1/posts/${post.short_id}/comments`);
        const [comment] = thread.body.comments;
        expect(comment.body).toBe('[deleted]');
        expect(comment.author).toBeNull();
        expect(comment.replies[0].body).toBe('reply');
    });

    it('shows removed comments as placeholders to the public but lets moderators read them', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        const comment = await createComment(bob.agent, post.id, { body: 'rude' });
        await alice.agent.post(`/v1/comments/${comment.id}/moderation`).send({ action: 'remove' });

        expect((await api().get(`/v1/posts/${post.id}/comments`)).body.comments[0].body).toBe('[removed]');
        expect((await alice.agent.get(`/v1/posts/${post.id}/comments`)).body.comments[0].body).toBe('rude');
    });

    it('drops pending comments entirely', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        const comment = await createComment(alice.agent, post.id);
        await prisma.comment.update({ where: { id: comment.id }, data: { status: 'pending' } });

        expect((await api().get(`/v1/posts/${post.id}/comments`)).body.comments).toEqual([]);
    });
});
