import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { createComment, createCommunity, createPost, makeModerator, signUp } from './helpers';

// Regression tests for roadmap bugs 1, 3, 4, 5, 6, 7 and 16

describe('comment edit and delete (bug 1)', () => {
    it("rejects editing or deleting someone else's comment", async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        const community = await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, community.id);
        const comment = await createComment(alice.agent, post.id, { content: 'original' });

        const edit = await bob.agent.post('/comment/edit-comment').send({ comment_id: comment.id, content: 'pwned' });
        expect(edit.status).toBe(403);

        const del = await bob.agent.post('/comment/delete-comment').send({ comment_id: comment.id });
        expect(del.status).toBe(403);

        const stored = await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } });
        expect(stored.content).toBe('original');
        expect(stored.status).toBe('active');
    });

    it('lets the author edit and delete their own comment', async () => {
        const alice = await signUp('alice');
        const community = await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, community.id);
        const comment = await createComment(alice.agent, post.id);

        const edit = await alice.agent.post('/comment/edit-comment').send({ comment_id: comment.id, content: 'edited' });
        expect(edit.status).toBe(200);

        const del = await alice.agent.post('/comment/delete-comment').send({ comment_id: comment.id });
        expect(del.status).toBe(200);
    });
});

describe('sponsorship is not user-settable (bug 3)', () => {
    it('ignores is_sponsored on posts and comments', async () => {
        const alice = await signUp('alice');
        const community = await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, community.id, { is_sponsored: true });
        await createComment(alice.agent, post.id, { is_sponsored: true });

        expect(await prisma.post.count({ where: { is_sponsored: true } })).toBe(0);
        expect(await prisma.comment.count({ where: { is_sponsored: true } })).toBe(0);
    });
});

describe('moderator actions (bugs 4 and 7)', () => {
    it('rejects a pin from a non-moderator who sends a real moderator id', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        const community = await createCommunity(alice.agent, 'lounge');
        const moderator = await makeModerator(alice.user.id, community.id);
        const post = await createPost(alice.agent, community.id);
        const comment = await createComment(alice.agent, post.id);

        const forged = await bob.agent.post('/comment/pin-comment').send({
            community_id: community.id,
            moderator_id: moderator.id,
            post_id: post.id,
            comment_id: comment.id,
        });
        expect(forged.status).toBe(403);

        const real = await alice.agent.post('/comment/pin-comment').send({ post_id: post.id, comment_id: comment.id });
        expect(real.status).toBe(200);
    });

    it('serves remove-post and only lets moderators of that community use it', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        const community = await createCommunity(alice.agent, 'lounge');
        await makeModerator(alice.user.id, community.id);
        const post = await createPost(bob.agent, community.id);
        const body = { community_id: community.id, postId: post.id, removed_reason: 'spam' };

        expect((await bob.agent.post('/post/remove-post').send(body)).status).toBe(403);

        expect((await alice.agent.post('/post/remove-post').send(body)).status).toBe(200);
        const stored = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
        expect(stored.status).toBe('removed');
    });
});

describe('communities (bugs 5 and 6)', () => {
    it('creates a community with a valid name and rejects an invalid one', async () => {
        const alice = await signUp('alice');

        const valid = await alice.agent.post('/community/create-community').send({ name: 'good_name' });
        expect(valid.status).toBe(200);

        const invalid = await alice.agent.post('/community/create-community').send({ name: '1bad name' });
        expect(invalid.status).toBe(400);
    });

    it('lets a user join more than one community', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        const first = await createCommunity(alice.agent, 'first');
        const second = await createCommunity(alice.agent, 'second');

        expect((await bob.agent.post('/community/join').send({ community_id: first.id })).status).toBe(200);
        expect((await bob.agent.post('/community/join').send({ community_id: second.id })).status).toBe(200);
        expect((await bob.agent.post('/community/join').send({ community_id: second.id })).status).toBe(400);
    });
});

describe('comment create (bug 16)', () => {
    it('rejects a parent comment from a different post', async () => {
        const alice = await signUp('alice');
        const community = await createCommunity(alice.agent, 'lounge');
        const postA = await createPost(alice.agent, community.id);
        const postB = await createPost(alice.agent, community.id);
        const parent = await createComment(alice.agent, postA.id);

        const response = await alice.agent
            .post('/comment/create')
            .send({ post_id: postB.id, content: 'cross-post reply', parent_comment_id: parent.id });
        expect(response.status).toBe(400);
    });

    it('returns the author with the new comment', async () => {
        const alice = await signUp('alice');
        const community = await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, community.id);

        const response = await alice.agent.post('/comment/create').send({ post_id: post.id, content: 'hi' });
        expect(response.body.comment.author_ref.username).toBe('alice');
        expect(response.body.comment._count.child_comments).toBe(0);
    });
});
