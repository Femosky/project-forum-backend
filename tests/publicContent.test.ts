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

describe('author deletes keep the discussion (tombstones)', () => {
    it('keeps a deleted post with comments open as a "[deleted]" tombstone and wipes its text', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge', { title: 'Renting a flat in Yaba', body: 'my private story' });
        await bob.agent.put(`/v1/posts/${post.id}/vote`).send({ value: 1 });
        await createComment(bob.agent, post.id, { body: 'useful answer' });
        await alice.agent.delete(`/v1/posts/${post.id}`);

        const stored = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
        expect(stored).toMatchObject({ status: 'deleted', body: '', url: null, link_preview: null });

        for (const agent of [api(), alice.agent, bob.agent]) {
            const page = await agent.get(`/v1/posts/${post.short_id}`);
            expect(page.status).toBe(200);
            expect(page.body.post).toMatchObject({ status: 'deleted', title: 'Renting a flat in Yaba', body: '', author: null, score: 0, upvote_count: 0 });
            expect(page.body.post.viewer?.views).toBeUndefined();
        }
        const thread = await api().get(`/v1/posts/${post.short_id}/comments`);
        expect(thread.body.comments.map((c: { body: string }) => c.body)).toEqual(['useful answer']);

        // Read-only, out of lists, still on the commenter's profile and live for crawlers
        expect((await bob.agent.post(`/v1/posts/${post.id}/comments`).send({ body: 'late comment' })).status).toBe(400);
        expect((await bob.agent.put(`/v1/posts/${post.id}/vote`).send({ value: -1 })).status).toBe(400);
        expect((await api().get('/v1/communities/lounge/posts')).body.posts).toEqual([]);
        expect((await api().get('/v1/users/bob/comments')).body.comments.map((c: { body: string }) => c.body)).toEqual(['useful answer']);
        expect((await api().get(`/v1/seo/status?type=post&id=${post.short_id}`)).body.state).toBe('live');
    });

    it('treats a deleted post as gone once no visible comments remain', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        const comment = await createComment(alice.agent, post.id);
        await alice.agent.delete(`/v1/posts/${post.id}`);
        expect((await api().get(`/v1/posts/${post.short_id}`)).status).toBe(200);

        await alice.agent.delete(`/v1/comments/${comment.id}`);
        expect((await api().get(`/v1/posts/${post.short_id}`)).status).toBe(404);
        expect((await api().get(`/v1/seo/status?type=post&id=${post.short_id}`)).body.state).toBe('gone');
    });

    it('hides deleted comments with nothing under them but keeps ones whose replies survive', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        const lonely = await createComment(alice.agent, post.id, { body: 'lonely' });
        const top = await createComment(alice.agent, post.id, { body: 'top' });
        const middle = await createComment(alice.agent, post.id, { body: 'middle', parent_id: top.id });
        await createComment(bob.agent, post.id, { body: 'deep reply', parent_id: middle.id });
        await bob.agent.put(`/v1/comments/${top.id}/vote`).send({ value: 1 });
        for (const comment of [lonely, top, middle]) await alice.agent.delete(`/v1/comments/${comment.id}`);

        const thread = await api().get(`/v1/posts/${post.short_id}/comments?sort=old`);
        expect(thread.body.comments).toHaveLength(1);
        const [kept] = thread.body.comments;
        expect(kept).toMatchObject({ body: '[deleted]', author: null, score: 0, upvote_count: 0 });
        expect(kept.replies[0]).toMatchObject({ body: '[deleted]', author: null });
        expect(kept.replies[0].replies[0].body).toBe('deep reply');

        // Once the last live reply goes, the whole chain disappears
        const deep = kept.replies[0].replies[0];
        await bob.agent.delete(`/v1/comments/${deep.id}`);
        expect((await api().get(`/v1/posts/${post.short_id}/comments`)).body.comments).toEqual([]);
    });

    it('still shows a "[removed]" reply under a deleted comment', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        const parent = await createComment(bob.agent, post.id, { body: 'parent' });
        const reply = await createComment(bob.agent, post.id, { body: 'rude', parent_id: parent.id });
        await alice.agent.post(`/v1/comments/${reply.id}/moderation`).send({ action: 'remove' });
        await bob.agent.delete(`/v1/comments/${parent.id}`);

        const [kept] = (await api().get(`/v1/posts/${post.short_id}/comments`)).body.comments;
        expect(kept.body).toBe('[deleted]');
        expect(kept.replies[0].body).toBe('[removed]');
    });
});


describe('posts deleted before tombstones', () => {
    it('never serves the text of a deleted post, even if it is still stored', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge', { body: 'old private text' });
        await createComment(bob.agent, post.id, { body: 'reply' });
        await prisma.post.update({ where: { id: post.id }, data: { status: 'deleted' } });

        const page = await api().get(`/v1/posts/${post.short_id}`);
        expect(page.body.post).toMatchObject({ body: '', author: null });
        expect(JSON.stringify(page.body)).not.toContain('old private text');
    });
});
