import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import prisma from '../src/prismaConnection';
import { judge } from '../src/modules/safety/moderation';
import { api, createCommunity, createPost, signInStaff, signUp } from './helpers';

// NSFW safety: the automatic content check (OpenAI moderation, faked here), holds only the admins can clear, the
// mature label, and keeping mature posts and communities out of lists unless the viewer asked for them

const realFetch = globalThis.fetch;

// Answers the moderation endpoint with these scores; anything else goes through
function fakeModeration(scores: Record<string, number> | 'down') {
    env.OPENAI_API_KEY = 'test-key';
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith('https://api.openai.com/')) return realFetch(input, init);
        if (scores === 'down') throw new Error('connect ECONNREFUSED');
        return new Response(JSON.stringify({ results: [{ category_scores: scores }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
}

afterEach(() => {
    vi.restoreAllMocks();
    delete env.OPENAI_API_KEY;
});

describe('judging moderation scores', () => {
    it('blocks minors, holds sexual content for admins, holds severe harm, labels the rest mature', () => {
        expect(judge(null)).toEqual({ action: 'publish' });
        expect(judge({ 'sexual/minors': 0.3, sexual: 0.9 })).toMatchObject({ action: 'hold_for_admins', reason: expect.stringContaining('minor') });
        expect(judge({ sexual: 0.8 })).toMatchObject({ action: 'hold_for_admins' });
        expect(judge({ 'violence/graphic': 0.95 })).toMatchObject({ action: 'hold' });
        expect(judge({ 'self-harm/intent': 0.8 })).toMatchObject({ action: 'hold' });
        expect(judge({ 'violence/graphic': 0.6 })).toMatchObject({ action: 'label_mature' });
        expect(judge({ sexual: 0.1, violence: 0.2 })).toEqual({ action: 'publish' });
    });
});

describe('automatic content check', () => {
    it('holds sexual content for the admins: the community moderator can only remove it, an admin can approve it', async () => {
        const owner = await signUp('owner');
        await createCommunity(owner.agent, 'lounge');
        const author = await signUp('author');
        fakeModeration({ sexual: 0.92 });
        const post = await createPost(author.agent, 'lounge', { title: 'Something explicit', body: 'explicit text' });

        const row = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
        expect(row).toMatchObject({ status: 'pending', held_for_admins: true, held_reason: expect.stringContaining('Sexual content') });

        // Not in the community's queue, and its moderator can't publish it
        const modQueue = await owner.agent.get('/v1/communities/lounge/mod-queue');
        expect(modQueue.status).toBe(200);
        expect(JSON.stringify(modQueue.body)).not.toContain(post.id);
        const approve = await owner.agent.post(`/v1/posts/${post.id}/moderation`).send({ action: 'approve' });
        expect(approve.status).toBe(403);
        expect(approve.body.error.code).toBe('held_for_admins');

        // The admin team decides, from the site queue
        const staff = await signInStaff('boss');
        const siteQueue = await staff.agent.get('/v1/admin/queue');
        expect(siteQueue.status).toBe(200);
        expect(JSON.stringify(siteQueue.body)).toContain(post.id);
        expect((await staff.agent.post(`/v1/admin/posts/${post.id}/moderation`).send({ action: 'approve' })).status).toBe(200);
        expect(await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: 'active', held_for_admins: false });
    });

    it('adds the mature label to graphic posts, and holds comments that suggest a minor', async () => {
        const owner = await signUp('owner');
        await createCommunity(owner.agent, 'news');
        fakeModeration({ 'violence/graphic': 0.7 });
        const post = await createPost(owner.agent, 'news', { title: 'Scene of the accident', body: 'graphic description' });
        expect(await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: 'active', is_nsfw: true });

        vi.restoreAllMocks();
        fakeModeration({ 'sexual/minors': 0.6, sexual: 0.7 });
        const reply = await owner.agent.post(`/v1/posts/${post.id}/comments`).send({ body: 'something unacceptable' });
        expect(reply.status).toBe(201);
        const comment = await prisma.comment.findUniqueOrThrow({ where: { id: reply.body.comment.id } });
        expect(comment).toMatchObject({ status: 'pending', held_for_admins: true, held_reason: expect.stringContaining('Do not approve') });
    });

    it('publishes as before when the service is down or there is no key', async () => {
        const owner = await signUp('owner');
        await createCommunity(owner.agent, 'lounge');
        fakeModeration('down');
        const down = await createPost(owner.agent, 'lounge', { title: 'While the check is down' });
        expect(await prisma.post.findUniqueOrThrow({ where: { id: down.id } })).toMatchObject({ status: 'active' });

        vi.restoreAllMocks();
        delete env.OPENAI_API_KEY;
        const noKey = await createPost(owner.agent, 'lounge', { title: 'Without a key' });
        expect(await prisma.post.findUniqueOrThrow({ where: { id: noKey.id } })).toMatchObject({ status: 'active' });
    });
});

describe('mature content in lists', () => {
    async function setup() {
        const owner = await signUp('owner');
        await createCommunity(owner.agent, 'lounge');
        await createCommunity(owner.agent, 'afterdark', { is_nsfw: true });
        const plain = await createPost(owner.agent, 'lounge', { title: 'Plain thread about jollof' });
        const marked = await createPost(owner.agent, 'lounge', { title: 'Marked thread about jollof', is_nsfw: true });
        const inMature = await createPost(owner.agent, 'afterdark', { title: 'Mature community thread about jollof' });
        await prisma.post.update({
            where: { id: marked.id },
            data: { link_preview: { title: 'A page', image: 'https://example.com/picture.png' } },
        });
        return { owner, plain, marked, inMature };
    }
    const ids = (posts: { id: string }[]) => posts.map((post) => post.id);

    it('keeps mature posts and communities out of feeds, search, autocomplete and the directory for guests', async () => {
        const { plain, marked, inMature } = await setup();
        const feed = await api().get('/v1/feed?scope=all&sort=new');
        expect(ids(feed.body.posts)).toContain(plain.id);
        expect(ids(feed.body.posts)).not.toContain(marked.id);
        expect(ids(feed.body.posts)).not.toContain(inMature.id);

        const search = await api().get('/v1/search?q=jollof&type=posts&exact=1');
        expect(ids(search.body.posts)).toEqual([plain.id]);

        const directory = await api().get('/v1/communities?sort=new');
        expect(directory.body.communities.map((community: { name: string }) => community.name)).not.toContain('afterdark');
        const suggestions = await api().get('/v1/search/autocomplete?q=after');
        expect(suggestions.body.communities).toEqual([]);
    });

    it('still opens mature posts directly, blurred and without a preview picture', async () => {
        const { marked, inMature } = await setup();
        const direct = await api().get(`/v1/posts/${marked.short_id}`);
        expect(direct.status).toBe(200);
        expect(direct.body.post).toMatchObject({ is_nsfw: true, blur_mature: true, is_indexable: false });
        expect(direct.body.post.link_preview).toEqual({ title: 'A page' });
        // A post in a mature community counts as mature too
        expect((await api().get(`/v1/posts/${inMature.short_id}`)).body.post).toMatchObject({ is_nsfw: true, blur_mature: true });
    });

    it('shows them, unblurred, to someone who switched on "Show mature content"', async () => {
        const { plain, marked, inMature } = await setup();
        const reader = await signUp('reader');
        const on = await reader.agent.patch('/v1/users/me').send({ show_mature: true });
        expect(on.body.user.show_mature).toBe(true);

        const feed = await reader.agent.get('/v1/feed?scope=all&sort=new');
        expect(ids(feed.body.posts)).toEqual(expect.arrayContaining([plain.id, marked.id, inMature.id]));
        expect(feed.body.posts.find((post: { id: string }) => post.id === marked.id)).toMatchObject({ blur_mature: false });
        const directory = await reader.agent.get('/v1/communities?sort=new');
        expect(directory.body.communities.map((community: { name: string }) => community.name)).toContain('afterdark');
    });
});
