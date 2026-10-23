import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { hotRank } from '../src/lib/ranking';
import { createComment, createCommunity, createPost, signUp } from './helpers';

describe('voting', () => {
    it('keeps one vote per user and moves counters, score, hot rank and karma together', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        const vote = (value: number) => bob.agent.put(`/v1/posts/${post.id}/vote`).send({ value });

        expect((await vote(1)).body).toEqual({ upvote_count: 1, downvote_count: 0, score: 1, vote: 1 });
        expect((await vote(1)).body).toMatchObject({ upvote_count: 1, score: 1 });
        expect((await vote(-1)).body).toEqual({ upvote_count: 0, downvote_count: 1, score: -1, vote: -1 });
        expect(await prisma.postVote.count()).toBe(1);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: alice.user.id } })).karma).toBe(-1);

        const stored = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
        expect(stored.hot_rank).toBeCloseTo(hotRank(-1, stored.created_at), 5);

        expect((await vote(0)).body).toEqual({ upvote_count: 0, downvote_count: 0, score: 0, vote: 0 });
        expect(await prisma.postVote.count()).toBe(0);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: alice.user.id } })).karma).toBe(0);

        expect((await bob.agent.put(`/v1/posts/${post.id}/vote`).send({ value: 2 })).status).toBe(400);
    });

    it('shows the viewer their own vote', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        await alice.agent.put(`/v1/posts/${post.id}/vote`).send({ value: -1 });

        const feed = await alice.agent.get('/v1/feed?scope=all');
        expect(feed.body.posts[0].viewer).toEqual({ vote: -1, saved: false, is_author: true });
        // Self-votes don't earn karma
        expect((await prisma.user.findUniqueOrThrow({ where: { id: alice.user.id } })).karma).toBe(0);
    });

    it('stays consistent under concurrent votes', async () => {
        const users = await Promise.all(['voter1', 'voter2', 'voter3', 'voter4', 'voter5', 'voter6'].map((name) => signUp(name)));
        await createCommunity(users[0].agent, 'lounge');
        const post = await createPost(users[0].agent, 'lounge');

        await Promise.all(
            users.flatMap(({ agent }, index) => [
                agent.put(`/v1/posts/${post.id}/vote`).send({ value: index % 2 === 0 ? 1 : -1 }),
                agent.put(`/v1/posts/${post.id}/vote`).send({ value: 1 }),
            ])
        );

        const stored = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
        const votes = await prisma.postVote.findMany({ where: { post_id: post.id } });
        expect(stored.upvote_count).toBe(votes.filter((v) => v.value === 1).length);
        expect(stored.downvote_count).toBe(votes.filter((v) => v.value === -1).length);
        expect(stored.score).toBe(stored.upvote_count - stored.downvote_count);
    });

    it('ranks comments by the Wilson lower bound for "best"', async () => {
        const users = await Promise.all(['alice', 'voter1', 'voter2', 'voter3'].map((name) => signUp(name)));
        const alice = users[0];
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        const lucky = await createComment(alice.agent, post.id, { body: 'one upvote' });
        const solid = await createComment(alice.agent, post.id, { body: 'three upvotes' });
        await users[1].agent.put(`/v1/comments/${lucky.id}/vote`).send({ value: 1 });
        for (const user of users.slice(1)) await user.agent.put(`/v1/comments/${solid.id}/vote`).send({ value: 1 });

        const best = await alice.agent.get(`/v1/posts/${post.id}/comments?sort=best`);
        expect(best.body.comments.map((c: { body: string }) => c.body)).toEqual(['three upvotes', 'one upvote']);
        expect(best.body.comments[1].viewer.vote).toBe(0);
    });

    it("refuses votes on removed posts and from people banned from the community", async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        await alice.agent.post('/v1/communities/lounge/bans').send({ username: 'bob' });
        expect((await bob.agent.put(`/v1/posts/${post.id}/vote`).send({ value: 1 })).status).toBe(403);

        await alice.agent.post(`/v1/posts/${post.id}/moderation`).send({ action: 'remove' });
        expect((await alice.agent.put(`/v1/posts/${post.id}/vote`).send({ value: 1 })).status).toBe(400);
    });
});

describe('saving', () => {
    it('saves and lists posts and comments', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge', { title: 'keeper' });
        const comment = await createComment(alice.agent, post.id, { body: 'good point' });

        await alice.agent.put(`/v1/posts/${post.id}/save`);
        await alice.agent.put(`/v1/posts/${post.id}/save`);
        await alice.agent.put(`/v1/comments/${comment.id}/save`);

        const posts = await alice.agent.get('/v1/users/me/saved?type=posts');
        expect(posts.body.posts.map((p: { title: string }) => p.title)).toEqual(['keeper']);
        expect(posts.body.posts[0].viewer.saved).toBe(true);
        const comments = await alice.agent.get('/v1/users/me/saved?type=comments');
        expect(comments.body.comments.map((c: { body: string }) => c.body)).toEqual(['good point']);

        await alice.agent.delete(`/v1/posts/${post.id}/save`);
        expect((await alice.agent.get('/v1/users/me/saved')).body.posts).toEqual([]);
    });
});
