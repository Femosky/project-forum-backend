import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { api, createComment, createCommunity, createPost, makeModerator, signUp } from './helpers';

describe('private communities', () => {
    it('hides posts from non-members and turns joins into requests', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'secret', { visibility: 'private' });
        const post = await createPost(alice.agent, 'secret');

        expect((await api().get('/v1/communities/secret/posts')).status).toBe(403);
        expect((await bob.agent.get(`/v1/posts/${post.id}`)).status).toBe(403);
        expect((await bob.agent.post('/v1/posts').send({ community: 'secret', title: 'hello there' })).status).toBe(403);

        const join = await bob.agent.put('/v1/communities/secret/membership').send({ message: 'let me in' });
        expect(join.status).toBe(202);
        expect((await bob.agent.get('/v1/communities/secret')).body.viewer).toMatchObject({ is_member: false, has_pending_request: true });

        const requests = await alice.agent.get('/v1/communities/secret/join-requests');
        expect(requests.body.requests[0]).toMatchObject({ message: 'let me in', user: { username: 'bob' } });
        expect((await bob.agent.get('/v1/communities/secret/join-requests')).status).toBe(403);

        await alice.agent.post(`/v1/communities/secret/join-requests/${requests.body.requests[0].id}`).send({ decision: 'accept' });
        expect((await bob.agent.get(`/v1/posts/${post.id}`)).status).toBe(200);
        expect((await prisma.community.findUniqueOrThrow({ where: { name: 'secret' } })).member_count).toBe(2);
    });
});

describe('roles and bans', () => {
    it('lets the owner appoint moderators, and moderators ban members but not the owner', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        const carol = await signUp('carol');
        await createCommunity(alice.agent, 'lounge');
        await bob.agent.put('/v1/communities/lounge/membership');
        await carol.agent.put('/v1/communities/lounge/membership');

        expect((await bob.agent.put('/v1/communities/lounge/members/carol/role').send({ role: 'moderator' })).status).toBe(403);
        expect((await alice.agent.put('/v1/communities/lounge/members/bob/role').send({ role: 'moderator' })).status).toBe(200);

        const detail = await api().get('/v1/communities/lounge');
        expect(detail.body.moderators.map((m: { username: string }) => m.username)).toEqual(['alice', 'bob']);

        expect((await bob.agent.post('/v1/communities/lounge/bans').send({ username: 'alice' })).status).toBe(403);
        const ban = await bob.agent.post('/v1/communities/lounge/bans').send({ username: 'carol', days: 3, reason: 'spam' });
        expect(ban.status).toBe(200);

        expect((await carol.agent.post('/v1/posts').send({ community: 'lounge', title: 'back again' })).status).toBe(403);
        expect((await carol.agent.put('/v1/communities/lounge/membership')).status).toBe(403);
        expect((await prisma.community.findUniqueOrThrow({ where: { name: 'lounge' } })).member_count).toBe(2);

        await bob.agent.delete('/v1/communities/lounge/bans/carol');
        expect((await carol.agent.put('/v1/communities/lounge/membership')).status).toBe(200);
    });

    it("won't let the owner leave without handing over", async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        expect((await alice.agent.delete('/v1/communities/lounge/membership')).status).toBe(400);
    });

    it('lets moderators edit the community and manage flairs', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');

        expect((await bob.agent.patch('/v1/communities/lounge').send({ description: 'mine now' })).status).toBe(403);
        const update = await alice.agent
            .patch('/v1/communities/lounge')
            .send({ description: 'Rent, jobs and everything else', rules: [{ title: 'Be kind' }] });
        expect(update.body.community).toMatchObject({ description: 'Rent, jobs and everything else', rules: [{ title: 'Be kind', description: '' }] });

        const flair = await alice.agent.post('/v1/communities/lounge/flairs').send({ name: 'Question', color: '#336699' });
        expect(flair.status).toBe(201);
        const post = await bob.agent.post('/v1/posts').send({ community: 'lounge', title: 'Where to rent?', flair_id: flair.body.flair.id });
        expect(post.body.post.flair).toMatchObject({ name: 'Question' });
        expect((await api().get('/v1/communities/lounge/flairs')).body.flairs).toHaveLength(1);
    });
});

describe('reports', () => {
    it('routes reports to the right moderators and closes them together', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        const carol = await signUp('carol');
        const community = await createCommunity(alice.agent, 'lounge');
        await makeModerator(alice.user.id, community.id);
        const post = await createPost(bob.agent, 'lounge');
        const comment = await createComment(bob.agent, post.id);

        const report = { target_type: 'comment', target_id: comment.id, reason_code: 'harassment', note: 'rude' };
        expect((await carol.agent.post('/v1/reports').send(report)).status).toBe(201);
        expect((await carol.agent.post('/v1/reports').send({ ...report, note: 'very rude' })).status).toBe(201);
        await alice.agent.post('/v1/reports').send({ ...report, reason_code: 'spam' });
        expect(await prisma.report.count()).toBe(2);

        expect((await carol.agent.get('/v1/communities/lounge/reports')).status).toBe(403);
        const queue = await alice.agent.get('/v1/communities/lounge/reports');
        expect(queue.body.reports).toHaveLength(2);

        const resolved = await alice.agent.post(`/v1/reports/${queue.body.reports[0].id}/resolve`).send({ status: 'resolved' });
        expect(resolved.body.closed).toBe(2);
        expect((await alice.agent.get('/v1/communities/lounge/reports')).body.reports).toEqual([]);

        // A report about a user goes to site admins
        await carol.agent.post('/v1/reports').send({ target_type: 'user', target_id: bob.user.id, reason_code: 'spam' });
        expect((await alice.agent.get('/v1/admin/reports')).status).toBe(403);
        const admin = await signUp('root', { admin: true });
        expect((await admin.agent.get('/v1/admin/reports')).body.reports).toHaveLength(1);
    });
});

describe('profiles and accounts', () => {
    it('updates the profile and deletes the account, detaching it from old posts', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');

        const update = await alice.agent.patch('/v1/users/me').send({ display_name: 'Alice O.', avatar_id: 'default_2' });
        expect(update.body.user).toMatchObject({ display_name: 'Alice O.', avatar_id: 'default_2' });
        expect((await alice.agent.patch('/v1/users/me').send({ avatar_id: 'nope' })).status).toBe(400);

        expect((await alice.agent.delete('/v1/users/me').send({ password: 'wrong' })).status).toBe(400);
        expect((await alice.agent.delete('/v1/users/me').send({ password: 'Passw0rd!Passw0rd' })).status).toBe(200);
        expect((await api().get('/v1/users/alice')).status).toBe(404);
        expect((await api().get(`/v1/posts/${post.id}`)).body.post.author).toBeNull();
        expect((await api().post('/v1/auth/login').send({ identifier: 'alice', password: 'Passw0rd!Passw0rd' })).status).toBe(401);
    });

    it('lists the communities a user joined', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const mine = await alice.agent.get('/v1/users/me/communities');
        expect(mine.body.communities).toMatchObject([{ name: 'lounge', role: 'owner' }]);
    });
});
