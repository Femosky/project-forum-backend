import { describe, expect, it } from 'vitest';
import { api, createComment, createCommunity, createPost, signUp } from './helpers';

describe('account data', () => {
    it('exports everything the account wrote, anonymous posts included, and only to its owner', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge', { title: 'secret', is_anonymous: true });
        await createComment(alice.agent, post.id, { body: 'my comment' });
        await alice.agent.put(`/v1/posts/${post.id}/vote`).send({ value: 1 });

        const response = await alice.agent.get('/v1/users/me/export');
        expect(response.status).toBe(200);
        expect(response.headers['content-disposition']).toContain('alice-data.json');
        expect(response.body.account.username).toBe('alice');
        expect(response.body.posts).toMatchObject([{ title: 'secret', is_anonymous: true, community: { name: 'lounge' } }]);
        expect(response.body.comments).toMatchObject([{ body: 'my comment' }]);
        expect(response.body.votes.posts).toHaveLength(1);
        expect(response.body.account.password_hash).toBeUndefined();

        expect((await api().get('/v1/users/me/export')).status).toBe(401);
    });

    it('lists saved comments with enough of their post to link to them', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge', { title: 'Hello there' });
        const comment = await createComment(alice.agent, post.id);
        await alice.agent.put(`/v1/comments/${comment.id}/save`);

        const saved = await alice.agent.get('/v1/users/me/saved?type=comments');
        expect(saved.body.comments[0].post).toMatchObject({ short_id: post.short_id, title: 'Hello there', community: 'lounge' });
        expect(saved.body.comments[0].post.slug).toBeTruthy();
    });
});
