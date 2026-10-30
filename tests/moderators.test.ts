import { describe, expect, it, vi } from 'vitest';
import prisma from '../src/prismaConnection';
import { devOutbox } from '../src/lib/email';
import { emailToken } from '../src/lib/emailTokens';
import { sendModeratorEmails } from '../src/modules/moderation/alerts';
import { api, signUp } from './helpers';

async function community(owner: Awaited<ReturnType<typeof signUp>>, name = 'lounge', visibility = 'public') {
    await owner.agent.post('/v1/communities').send({ name, description: 'A place', visibility }).expect(201);
    return prisma.community.findUniqueOrThrow({ where: { name } });
}

async function inviteAndAccept(owner: Awaited<ReturnType<typeof signUp>>, mod: Awaited<ReturnType<typeof signUp>>, permission = 'all') {
    await owner.agent.post('/v1/communities/lounge/team/invites').send({ username: mod.user.username, permission }).expect(201);
    const { invites } = (await mod.agent.get('/v1/moderation/overview')).body;
    await mod.agent.post(`/v1/moderation/invites/${invites[0].id}`).send({ decision: 'accept' }).expect(200);
}

const alerts = (userId: string) => vi.waitFor(async () => {
    const rows = await prisma.notification.findMany({ where: { user_id: userId, type: { in: ['mod_queue', 'mod_report', 'mod_join_request'] } } });
    expect(rows.length).toBeGreaterThan(0);
    return rows;
});

describe('the moderator team', () => {
    it('invites a moderator, who accepts, and logs each step', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await community(alice);

        expect((await bob.agent.post('/v1/communities/lounge/team/invites').send({ username: 'alice' })).status).toBe(403);
        await inviteAndAccept(alice, bob);

        const team = (await bob.agent.get('/v1/communities/lounge/team')).body.moderators;
        expect(team.map((mod: { username: string; role: string }) => [mod.username, mod.role])).toEqual([
            ['alice', 'owner'],
            ['bob', 'moderator'],
        ]);
        const log = await prisma.modAction.findMany({ select: { action: true } });
        expect(log.map((row) => row.action)).toEqual(expect.arrayContaining(['invite_mod', 'accept_mod_invite']));
    });

    it('limits posts-only moderators to the queue', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await signUp('carol');
        await community(alice);
        await inviteAndAccept(alice, bob, 'posts');

        expect((await bob.agent.get('/v1/communities/lounge/mod-queue')).status).toBe(200);
        const ban = await bob.agent.post('/v1/communities/lounge/bans').send({ username: 'carol' });
        expect(ban.status).toBe(403);
        expect(ban.body.error.code).toBe('posts_only_moderator');
    });

    it('removes moderators, lets them step down, and hands over ownership', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await community(alice);
        await inviteAndAccept(alice, bob);

        expect((await alice.agent.post('/v1/communities/lounge/transfer').send({ username: 'alice' })).status).toBe(400);
        await alice.agent.post('/v1/communities/lounge/transfer').send({ username: 'bob' }).expect(200);
        const viewer = (await bob.agent.get('/v1/communities/lounge')).body.viewer;
        expect(viewer.role).toBe('owner');

        await bob.agent.delete('/v1/communities/lounge/team/alice').expect(200);
        expect((await alice.agent.get('/v1/communities/lounge')).body.viewer.role).toBe('member');
    });
});

describe('telling moderators', () => {
    it('counts in one notification, shows on the overview, and emails within the limits', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        const carol = await signUp('carol');
        const lounge = await community(alice, 'lounge', 'private');
        await prisma.user.update({ where: { id: alice.user.id }, data: { email_verified_at: new Date() } });

        await bob.agent.put('/v1/communities/lounge/membership').send({}).expect(202);
        await alerts(alice.user.id);
        await carol.agent.put('/v1/communities/lounge/membership').send({}).expect(202);
        await vi.waitFor(async () => {
            const [row] = await alerts(alice.user.id);
            expect(row.count).toBe(2);
        });

        const overview = (await alice.agent.get('/v1/moderation/overview')).body;
        expect(overview.communities[0]).toMatchObject({ name: 'lounge', role: 'owner', join_requests: 2, email: 'daily' });
        expect(overview.total).toBe(2);
        const notice = (await alice.agent.get('/v1/notifications')).body.notifications[0];
        expect(notice).toMatchObject({ type: 'mod_join_request', community: 'lounge', count: 2 });

        // A daily digest goes once, then waits a day
        const sent = () => devOutbox.filter((mail) => mail.to === 'alice@example.test' && mail.subject.includes('c/lounge')).length;
        const before = sent();
        await sendModeratorEmails();
        expect(sent()).toBe(before + 1);
        await sendModeratorEmails();
        expect(sent()).toBe(before + 1);

        // Instant: at most one per ten minutes, even with something new
        await alice.agent.put('/v1/communities/lounge/mod-email').send({ frequency: 'instant' }).expect(200);
        await prisma.notification.updateMany({ where: { user_id: alice.user.id }, data: { created_at: new Date(Date.now() + 1000) } });
        await sendModeratorEmails(new Date(Date.now() + 2000));
        expect(sent()).toBe(before + 1);
        await sendModeratorEmails(new Date(Date.now() + 11 * 60 * 1000));
        expect(sent()).toBe(before + 2);

        // The unsubscribe link needs no sign-in and turns this community's emails off
        const token = emailToken({ kind: 'mod', userId: alice.user.id, ref: lounge.id });
        expect((await api().post('/v1/email/unsubscribe').send({ token: `${token}x` })).status).toBe(400);
        await api().post('/v1/email/unsubscribe').send({ token }).expect(200);
        await prisma.notification.updateMany({ where: { user_id: alice.user.id }, data: { created_at: new Date(Date.now() + 3 * 3600 * 1000) } });
        await sendModeratorEmails(new Date(Date.now() + 4 * 3600 * 1000));
        expect(sent()).toBe(before + 2);
    });

    it('lets moderators answer join requests, logged', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await community(alice, 'lounge', 'private');
        await bob.agent.put('/v1/communities/lounge/membership').send({ message: 'hi' }).expect(202);
        const { requests } = (await alice.agent.get('/v1/communities/lounge/join-requests')).body;
        await alice.agent.post(`/v1/communities/lounge/join-requests/${requests[0].id}`).send({ decision: 'accept' }).expect(200);
        expect((await bob.agent.get('/v1/communities/lounge')).body.viewer.is_member).toBe(true);
        expect(await prisma.modAction.count({ where: { action: 'accept_join_request' } })).toBe(1);
    });
});

describe('Lead mods and handing communities over', () => {
    it('lets a Lead mod manage moderators, but not other Leads or the community itself', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        const carol = await signUp('carol');
        await community(alice);
        await inviteAndAccept(alice, bob, 'lead');

        const lead = await bob.agent.post('/v1/communities/lounge/team/invites').send({ username: 'carol', permission: 'lead' });
        expect(lead.status).toBe(403);
        await inviteAndAccept(bob, carol);
        await bob.agent.patch('/v1/communities/lounge/team/carol').send({ permission: 'posts' }).expect(200);
        expect((await bob.agent.post('/v1/communities/lounge/transfer').send({ username: 'carol' })).status).toBe(403);
    });

    it('passes a deleted owner\'s community to the chosen successor, the longest-serving moderator, or the site', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        const carol = await signUp('carol');
        await community(alice);
        await community(alice, 'cafe');
        await community(alice, 'quiet');
        await inviteAndAccept(alice, bob);
        await alice.agent.post('/v1/communities/cafe/team/invites').send({ username: 'bob' }).expect(201);
        await alice.agent.post('/v1/communities/cafe/team/invites').send({ username: 'carol' }).expect(201);
        for (const person of [bob, carol]) {
            const { invites } = (await person.agent.get('/v1/moderation/overview')).body;
            for (const invite of invites) await person.agent.post(`/v1/moderation/invites/${invite.id}`).send({ decision: 'accept' }).expect(200);
        }

        const owned = (await alice.agent.get('/v1/users/me/owned-communities')).body.communities;
        expect(owned).toHaveLength(3);
        await alice.agent.delete('/v1/users/me').send({ password: alice.password, successors: { cafe: 'carol' } }).expect(200);

        const ownerOf = async (name: string) =>
            (await prisma.communityMember.findFirstOrThrow({ where: { community: { name }, role: 'owner' }, select: { user: { select: { username: true } } } })).user.username;
        expect(await ownerOf('lounge')).toBe('bob');
        expect(await ownerOf('cafe')).toBe('carol');
        expect(await ownerOf('quiet')).toBe('site_team');
        expect((await prisma.community.findUniqueOrThrow({ where: { name: 'quiet' } })).needs_moderator).toBe(true);
    });

    it('keeps the site account out of reach', async () => {
        const taken = await api().post('/v1/auth/signup').send({ email: 'x@example.test', username: 'site_team', password: 'Passw0rd!Passw0rd', is_adult: true });
        expect(taken.body.error.code).toBe('username_taken');
    });
});
