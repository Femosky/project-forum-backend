import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { api, createComment, createCommunity, createPost, signUp } from './helpers';
import { LIVE_MAX_HOURS } from '../src/modules/posts/live';

describe('live threads', () => {
    it('lets moderators and trusted authors start and end a live thread, and nobody else', async () => {
        const owner = await signUp('owner');
        const bob = await signUp('bob');
        await createCommunity(owner.agent, 'matchday');
        const bobsPost = await createPost(bob.agent, 'matchday', { title: 'Nigeria vs Tanzania live updates' });

        // An ordinary author can't put their own post on the home page
        expect((await bob.agent.put(`/v1/posts/${bobsPost.id}/live`).send({ live: true })).status).toBe(403);
        expect((await bob.agent.get(`/v1/posts/${bobsPost.id}`)).body.post.viewer.can_set_live).toBe(false);

        // Once trusted, they can
        await prisma.user.update({ where: { id: bob.user.id }, data: { is_trusted: true } });
        expect((await bob.agent.get(`/v1/posts/${bobsPost.id}`)).body.post.viewer.can_set_live).toBe(true);
        const started = await bob.agent.put(`/v1/posts/${bobsPost.id}/live`).send({ live: true });
        expect(started.status).toBe(200);
        expect(started.body.post.live).toMatchObject({ is_live: true, ended_at: null });

        // The community's moderator can end it
        const ended = await owner.agent.put(`/v1/posts/${bobsPost.id}/live`).send({ live: false });
        expect(ended.body.post.live.is_live).toBe(false);
        expect(ended.body.post.live.ended_at).not.toBeNull();

        // Guests see the state but no switch
        const guest = await api().get(`/v1/posts/${bobsPost.id}`);
        expect(guest.body.post.live.is_live).toBe(false);
        expect(guest.body.post.viewer).toBeNull();
    });

    it('stops being live by itself after the time limit', async () => {
        const owner = await signUp('owner');
        await createCommunity(owner.agent, 'matchday');
        const post = await createPost(owner.agent, 'matchday');
        await owner.agent.put(`/v1/posts/${post.id}/live`).send({ live: true });
        await prisma.post.update({ where: { id: post.id }, data: { live_started_at: new Date(Date.now() - (LIVE_MAX_HOURS + 1) * 3600_000) } });

        expect((await api().get(`/v1/posts/${post.id}`)).body.post.live.is_live).toBe(false);
        expect((await api().get('/v1/feed/live')).body.posts).toEqual([]);
    });

    it('leads its community and the home page strip while live', async () => {
        const owner = await signUp('owner');
        await createCommunity(owner.agent, 'matchday');
        const live = await createPost(owner.agent, 'matchday', { title: 'Live thread' });
        for (let i = 0; i < 3; i++) await createPost(owner.agent, 'matchday');
        await owner.agent.put(`/v1/posts/${live.id}/live`).send({ live: true });

        const community = await api().get('/v1/communities/matchday/posts');
        expect(community.body.posts[0].id).toBe(live.id);
        expect(community.body.posts.filter((p: { id: string }) => p.id === live.id)).toHaveLength(1);

        const strip = await api().get('/v1/feed/live');
        expect(strip.body.posts.map((p: { id: string }) => p.id)).toEqual([live.id]);

        await owner.agent.put(`/v1/posts/${live.id}/live`).send({ live: false });
        expect((await api().get('/v1/feed/live')).body.posts).toEqual([]);
    });

    it('returns only the top-level comments added after the newest one the reader has', async () => {
        const owner = await signUp('owner');
        const reader = await signUp('reader');
        await createCommunity(owner.agent, 'matchday');
        const post = await createPost(owner.agent, 'matchday');
        await owner.agent.put(`/v1/posts/${post.id}/live`).send({ live: true });

        const first = await createComment(owner.agent, post.id, { body: 'Kick-off' });
        const empty = await reader.agent.get(`/v1/posts/${post.id}/live-updates?after=${first.id}`);
        expect(empty.body.comments).toEqual([]);
        expect(empty.body.live.is_live).toBe(true);

        await createComment(reader.agent, post.id, { body: 'reply to kick-off', parent_id: first.id });
        const goal = await createComment(owner.agent, post.id, { body: 'Goal! 1-0' });
        const later = await createComment(reader.agent, post.id, { body: 'What a finish' });

        const updates = await reader.agent.get(`/v1/posts/${post.id}/live-updates?after=${first.id}`);
        expect(updates.body.comments.map((c: { body: string }) => c.body)).toEqual(['What a finish', 'Goal! 1-0']);
        expect(updates.body.comment_count).toBe(4);
        expect(updates.body.comments.map((c: { id: string }) => c.id)).toEqual([later.id, goal.id]);

        // No `after` on an empty page: everything so far
        expect((await reader.agent.get(`/v1/posts/${post.id}/live-updates`)).body.comments).toHaveLength(3);
        expect((await reader.agent.get(`/v1/posts/${post.id}/live-updates?after=nope`)).status).toBe(400);
    });
});
