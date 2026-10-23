import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { api, createComment, createCommunity, createPost, signUp } from './helpers';

// Regression tests for roadmap bugs 2, 8 and 9

describe('anonymous content (bug 2)', () => {
    it('never exposes the author of anonymous posts and comments', async () => {
        const alice = await signUp('alice');
        const community = await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, community.id, { title: 'secret', is_anonymous: true });
        await createComment(alice.agent, post.id, { content: 'anon comment', is_anonymous: true });

        const list = await api().get('/community/lounge/posts');
        const listed = list.body.posts.find((p: { title: string }) => p.title === 'secret');
        expect(listed.author_ref).toBeNull();
        expect(listed.author_id).toBeNull();

        const detail = await api().get(`/community/lounge/replies/${post.short_id}`);
        expect(detail.body.post.author_ref).toBeNull();
        expect(detail.body.comments[0].author_ref).toBeNull();
        expect(JSON.stringify(detail.body)).not.toContain(alice.user.id);
    });

    it("leaves anonymous posts off the author's public profile", async () => {
        const alice = await signUp('alice');
        const community = await createCommunity(alice.agent, 'lounge');
        await createPost(alice.agent, community.id, { title: 'public' });
        await createPost(alice.agent, community.id, { title: 'secret', is_anonymous: true });

        const profile = await api().get('/user/alice/posts');
        expect(profile.body.posts.map((p: { title: string }) => p.title)).toEqual(['public']);
        expect(profile.body.pagination.total_items).toBe(1);
    });
});

describe('sorting (bug 8)', () => {
    it('applies newest and oldest sort orders', async () => {
        const alice = await signUp('alice');
        const community = await createCommunity(alice.agent, 'lounge');
        const first = await createPost(alice.agent, community.id, { title: 'first' });
        await prisma.post.update({ where: { id: first.id }, data: { created_at: new Date('2026-01-01') } });
        await createPost(alice.agent, community.id, { title: 'second' });

        const newest = await api().get('/community/lounge/posts?sort_by=newest');
        expect(newest.body.posts.map((p: { title: string }) => p.title)).toEqual(['second', 'first']);

        const oldest = await api().get('/community/lounge/posts?sort_by=oldest');
        expect(oldest.body.posts.map((p: { title: string }) => p.title)).toEqual(['first', 'second']);
    });
});

describe('status filters (bug 9)', () => {
    it('hides hidden and removed posts from lists and detail pages', async () => {
        const alice = await signUp('alice');
        const community = await createCommunity(alice.agent, 'lounge');
        const visible = await createPost(alice.agent, community.id, { title: 'visible' });
        const hidden = await createPost(alice.agent, community.id, { title: 'hidden' });
        await prisma.post.update({ where: { id: hidden.id }, data: { status: 'hidden' } });

        const list = await api().get('/community/lounge/posts');
        expect(list.body.posts.map((p: { title: string }) => p.title)).toEqual(['visible']);
        expect(list.body.pagination.total_items).toBe(1);

        expect((await api().get(`/community/lounge/replies/${hidden.short_id}`)).status).toBe(404);
        expect((await api().get(`/community/lounge/replies/${visible.short_id}`)).status).toBe(200);
    });

    it('shows a deleted comment as a placeholder so its replies keep their place', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        const community = await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, community.id);
        const parent = await createComment(alice.agent, post.id, { content: 'will be deleted' });
        await createComment(bob.agent, post.id, { content: 'reply', parent_comment_id: parent.id });
        await alice.agent.post('/comment/delete-comment').send({ comment_id: parent.id });

        const detail = await api().get(`/community/lounge/replies/${post.short_id}`);
        const [comment] = detail.body.comments;
        expect(comment.content).toBe('[deleted]');
        expect(comment.author_ref).toBeNull();
        expect(comment.child_comments[0].content).toBe('reply');
    });

    it('drops hidden comments entirely', async () => {
        const alice = await signUp('alice');
        const community = await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, community.id);
        const comment = await createComment(alice.agent, post.id);
        await prisma.comment.update({ where: { id: comment.id }, data: { status: 'hidden' } });

        const detail = await api().get(`/community/lounge/replies/${post.short_id}`);
        expect(detail.body.comments).toEqual([]);
    });
});
