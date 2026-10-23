import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { api, createCommunity, createPost, signUp } from './helpers';

const titles = (body: { posts: { title: string }[] }) => body.posts.map((post) => post.title);

describe('feed', () => {
    it('pages with a cursor without repeating posts when new ones arrive', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        for (let i = 0; i < 5; i++) await createPost(alice.agent, 'lounge', { title: `post ${i}` });

        const first = await api().get('/v1/feed?sort=new&limit=2');
        expect(titles(first.body)).toEqual(['post 4', 'post 3']);

        // A new post lands between page loads; offset paging would repeat "post 3"
        await createPost(alice.agent, 'lounge', { title: 'post 5' });
        const second = await api().get(`/v1/feed?sort=new&limit=2&cursor=${first.body.next_cursor}`);
        expect(titles(second.body)).toEqual(['post 2', 'post 1']);
        const third = await api().get(`/v1/feed?sort=new&limit=2&cursor=${second.body.next_cursor}`);
        expect(titles(third.body)).toEqual(['post 0']);
        expect(third.body.next_cursor).toBeNull();
    });

    it("shows members their communities and everyone else the public site", async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        await createCommunity(alice.agent, 'jobs');
        await createCommunity(alice.agent, 'secret', { visibility: 'private' });
        await createPost(alice.agent, 'lounge', { title: 'lounge post' });
        await createPost(alice.agent, 'jobs', { title: 'jobs post' });
        await createPost(alice.agent, 'secret', { title: 'secret post' });

        // Guests: every public community, never private ones
        const guest = await api().get('/v1/feed?sort=new');
        expect(guest.body.scope).toBe('all');
        expect(titles(guest.body)).toEqual(['jobs post', 'lounge post']);

        // Bob hasn't joined anything yet, so he gets the public feed too
        expect((await bob.agent.get('/v1/feed?sort=new')).body.scope).toBe('all');

        await bob.agent.put('/v1/communities/jobs/membership');
        const home = await bob.agent.get('/v1/feed?sort=new');
        expect(home.body.scope).toBe('home');
        expect(titles(home.body)).toEqual(['jobs post']);

        // Alice belongs to the private one, so it is in her home feed
        expect(titles((await alice.agent.get('/v1/feed?sort=new')).body)).toContain('secret post');
    });

    it('limits "top" to the chosen window', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const old = await createPost(alice.agent, 'lounge', { title: 'last month' });
        await prisma.post.update({ where: { id: old.id }, data: { created_at: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000), score: 50 } });
        await createPost(alice.agent, 'lounge', { title: 'today' });

        expect(titles((await api().get('/v1/feed?sort=top&t=week')).body)).toEqual(['today']);
        expect(titles((await api().get('/v1/feed?sort=top&t=month')).body)).toEqual(['last month', 'today']);
    });
});
