import { describe, expect, it } from 'vitest';
import { api, createComment, createCommunity, createPost, PASSWORD, signUp } from './helpers';

// The web app (Phase 1) still calls these pre-v1 routes; they must keep their old shapes until Phase 3 moves it to /v1.

describe('legacy routes used by the web app', () => {
    it('serves the home list, community header, post page and replies in the old shapes', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge', { title: 'Hello', body: 'First post' });
        const top = await createComment(bob.agent, post.id, { body: 'top' });
        for (let i = 0; i < 3; i++) await createComment(alice.agent, post.id, { body: `reply ${i}`, parent_id: top.id });
        await bob.agent.put(`/v1/posts/${post.id}/vote`).send({ value: 1 });

        // The home page still asks for "hi": it gets every public community's posts
        const list = await api().get('/community/hi/posts');
        expect(list.body.posts[0]).toMatchObject({
            short_id: post.short_id,
            title: 'Hello',
            content: 'First post',
            author_ref: { username: 'alice', avatar_id: 'default_1' },
            community_ref: { name: 'lounge' },
            _count: { comments: 4, upvoters: 1, downvoters: 0 },
        });
        expect(list.body.pagination).toMatchObject({ current_page: 1, total_items: 1, has_next_page: false });

        expect((await api().get('/community/lounge/posts')).body.posts).toHaveLength(1);

        const community = await api().get('/community/lounge');
        expect(community.body.community).toMatchObject({ name: 'lounge', _count: { members: 1, posts: 1 } });

        const page = await api().get(`/community/lounge/replies/${post.short_id}`);
        expect(page.body.post.community_ref.name).toBe('lounge');
        const [comment] = page.body.comments;
        expect(comment).toMatchObject({ content: 'top', parent_comment_id: null, _count: { child_comments: 3 } });
        expect(comment.child_comments).toHaveLength(2);

        const more = await api().get(`/community/lounge/replies/${post.short_id}/reply/${top.short_id}?parent_limit=50`);
        expect(more.body.comments).toHaveLength(3);
        expect(more.body.comments[0].parent_comment_id).toBe(top.id);
    });

    it('logs in, lists joined communities and creates comments the old way', async () => {
        await signUp('alice');
        const { agent } = await signUp('bob');
        const alice = await signUp('carol');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        await agent.put('/v1/communities/lounge/membership');

        const login = await api().post('/auth/login').send({ username: 'alice', password: PASSWORD });
        expect(login.status).toBe(200);
        expect(login.body.user.username).toBe('alice');

        const communities = await agent.get('/community/get/communities');
        expect(communities.body.communities).toMatchObject([{ name: 'lounge' }]);

        const created = await agent.post('/comment/create').send({ post_id: post.id, content: 'old style', is_anonymous: false });
        expect(created.status).toBe(200);
        expect(created.body.comment).toMatchObject({
            content: 'old style',
            author_ref: { username: 'bob' },
            child_comments: [],
            _count: { child_comments: 0, upvoters: 0, downvoters: 0 },
        });

        const reply = await agent
            .post('/comment/create')
            .send({ post_id: post.id, content: 'a reply', parent_comment_id: created.body.comment.id });
        expect(reply.body.comment.parent_comment_id).toBe(created.body.comment.id);

        expect((await api().get('/community/get/communities')).status).toBe(401);
        expect((await api().get('/community/get/communities')).body).toEqual({ error: 'Sign in to continue.' });
    });
});
