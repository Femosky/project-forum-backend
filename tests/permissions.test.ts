import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { createComment, createCommunity, createPost, makeModerator, signUp } from './helpers';

// Regression tests for roadmap bugs 1, 3, 4, 5, 6, 7 and 16

describe('comment edit and delete (bug 1)', () => {
    it("rejects editing or deleting someone else's comment", async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        const comment = await createComment(alice.agent, post.id, { body: 'original' });

        expect((await bob.agent.patch(`/v1/comments/${comment.id}`).send({ body: 'pwned' })).status).toBe(403);
        expect((await bob.agent.delete(`/v1/comments/${comment.id}`)).status).toBe(403);

        const stored = await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } });
        expect(stored.body).toBe('original');
        expect(stored.status).toBe('active');
    });

    it('lets the author edit and delete their own comment', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        const comment = await createComment(alice.agent, post.id);

        const edit = await alice.agent.patch(`/v1/comments/${comment.id}`).send({ body: 'edited' });
        expect(edit.status).toBe(200);
        expect(edit.body.comment.edited_at).not.toBeNull();

        expect((await alice.agent.delete(`/v1/comments/${comment.id}`)).status).toBe(200);
        const stored = await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } });
        expect(stored.status).toBe('deleted');
        expect(stored.body).toBe('');
        expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).comment_count).toBe(0);
    });

    it("rejects editing or deleting someone else's post", async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        expect((await bob.agent.patch(`/v1/posts/${post.id}`).send({ body: 'pwned' })).status).toBe(403);
        expect((await bob.agent.delete(`/v1/posts/${post.id}`)).status).toBe(403);
    });
});

describe('sponsorship is not user-settable (bug 3)', () => {
    it('ignores is_sponsored on posts and comments, and only admins can sponsor', async () => {
        const alice = await signUp('alice');
        const admin = await signUp('root', { admin: true });
        const community = await createCommunity(alice.agent, 'lounge');
        await makeModerator(alice.user.id, community.id);
        const post = await createPost(alice.agent, 'lounge', { is_sponsored: true });
        await createComment(alice.agent, post.id, { is_sponsored: true });

        expect(await prisma.post.count({ where: { is_sponsored: true } })).toBe(0);
        expect(await prisma.comment.count({ where: { is_sponsored: true } })).toBe(0);

        // Even the community owner can't sponsor
        expect((await alice.agent.post(`/v1/posts/${post.id}/moderation`).send({ action: 'sponsor' })).status).toBe(403);
        expect((await admin.agent.post(`/v1/posts/${post.id}/moderation`).send({ action: 'sponsor' })).status).toBe(200);
        expect(await prisma.post.count({ where: { is_sponsored: true } })).toBe(1);
    });
});

describe('moderator actions (bugs 4 and 7)', () => {
    it('rejects a pin from a non-moderator, whatever ids they send', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        const community = await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        const comment = await createComment(alice.agent, post.id);

        const forged = await bob.agent
            .post(`/v1/comments/${comment.id}/moderation`)
            .send({ action: 'pin', moderator_id: alice.user.id, community_id: community.id });
        expect(forged.status).toBe(403);

        const real = await alice.agent.post(`/v1/comments/${comment.id}/moderation`).send({ action: 'pin' });
        expect(real.status).toBe(200);
        expect(real.body.comment.pinned_at).not.toBeNull();
    });

    it('only lets moderators of that community remove a post, and logs it', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        const community = await createCommunity(alice.agent, 'lounge');
        await createCommunity(bob.agent, 'elsewhere');
        const post = await createPost(bob.agent, 'lounge');

        // Owning another community doesn't help
        expect((await bob.agent.post(`/v1/posts/${post.id}/moderation`).send({ action: 'remove' })).status).toBe(403);

        const removed = await alice.agent.post(`/v1/posts/${post.id}/moderation`).send({ action: 'remove', reason: 'spam' });
        expect(removed.status).toBe(200);
        expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe('removed');
        expect((await prisma.community.findUniqueOrThrow({ where: { id: community.id } })).post_count).toBe(0);

        const log = await alice.agent.get('/v1/communities/lounge/mod-log');
        expect(log.body.actions[0]).toMatchObject({ action: 'remove_post', reason: 'spam', actor: { username: 'alice' } });
    });
});

describe('communities (bugs 5 and 6)', () => {
    it('creates a community with a valid name and rejects invalid or reserved ones', async () => {
        const alice = await signUp('alice');

        const valid = await alice.agent.post('/v1/communities').send({ name: 'Good_Name' });
        expect(valid.status).toBe(201);
        expect(valid.body.community).toMatchObject({ name: 'good_name', member_count: 1 });

        expect((await alice.agent.post('/v1/communities').send({ name: '1bad name' })).status).toBe(400);
        expect((await alice.agent.post('/v1/communities').send({ name: 'x'.repeat(22) })).status).toBe(400);
        expect((await alice.agent.post('/v1/communities').send({ name: 'admin' })).status).toBe(400);
        expect((await alice.agent.post('/v1/communities').send({ name: 'good_name' })).status).toBe(409);
    });

    it('lets a user join more than one community', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'first');
        await createCommunity(alice.agent, 'second');

        expect((await bob.agent.put('/v1/communities/first/membership')).status).toBe(200);
        expect((await bob.agent.put('/v1/communities/second/membership')).status).toBe(200);
        expect((await bob.agent.put('/v1/communities/second/membership')).status).toBe(409);
        expect((await prisma.community.findUniqueOrThrow({ where: { name: 'second' } })).member_count).toBe(2);
    });
});

describe('content rules (bug 16)', () => {
    it('rejects a parent comment from a different post', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const postA = await createPost(alice.agent, 'lounge');
        const postB = await createPost(alice.agent, 'lounge');
        const parent = await createComment(alice.agent, postA.id);

        const response = await alice.agent
            .post(`/v1/posts/${postB.id}/comments`)
            .send({ body: 'cross-post reply', parent_id: parent.id });
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('parent_mismatch');
    });

    it('enforces length limits on titles, posts and comments', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');

        const longTitle = await alice.agent.post('/v1/posts').send({ community: 'lounge', title: 'x'.repeat(301) });
        const shortTitle = await alice.agent.post('/v1/posts').send({ community: 'lounge', title: 'xy' });
        const longBody = await alice.agent.post('/v1/posts').send({ community: 'lounge', title: 'ok title', body: 'x'.repeat(40_001) });
        const longComment = await alice.agent.post(`/v1/posts/${post.id}/comments`).send({ body: 'x'.repeat(10_001) });
        const emptyComment = await alice.agent.post(`/v1/posts/${post.id}/comments`).send({ body: '   ' });

        for (const response of [longTitle, shortTitle, longBody, longComment, emptyComment]) {
            expect(response.status).toBe(400);
            expect(response.body.error.code).toBe('validation_failed');
        }
        expect((await alice.agent.post(`/v1/posts/${post.id}/comments`).send({ body: 'x'.repeat(10_000) })).status).toBe(201);
    });

    it('blocks comments on locked posts and replies to deleted comments', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        const comment = await createComment(bob.agent, post.id);
        await bob.agent.delete(`/v1/comments/${comment.id}`);

        const reply = await alice.agent.post(`/v1/posts/${post.id}/comments`).send({ body: 'hi', parent_id: comment.id });
        expect(reply.status).toBe(400);

        await alice.agent.post(`/v1/posts/${post.id}/moderation`).send({ action: 'lock' });
        const locked = await bob.agent.post(`/v1/posts/${post.id}/comments`).send({ body: 'hi' });
        expect(locked.status).toBe(403);
        expect(locked.body.error.code).toBe('post_locked');
    });

    it('returns the author with a new comment', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        const response = await alice.agent.post(`/v1/posts/${post.id}/comments`).send({ body: 'hi' });
        expect(response.body.comment.author.username).toBe('alice');
        expect(response.body.comment.reply_count).toBe(0);
    });
});
