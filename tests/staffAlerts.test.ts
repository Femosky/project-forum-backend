import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { devOutbox } from '../src/lib/email';
import { sendStaffAlerts } from '../src/modules/moderation/staffAlerts';
import { createCommunity, createPost, signInStaff, signUp } from './helpers';

describe('reports about moderators', () => {
    it("keeps them out of the community's queue and in the admins'", async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        const carol = await signUp('carol');
        await createCommunity(alice.agent, 'lounge');
        await bob.agent.put('/v1/communities/lounge/membership').send({}).expect(200);
        const byOwner = await createPost(alice.agent, 'lounge');
        const byMember = await createPost(bob.agent, 'lounge');

        const report = (id: string) => carol.agent.post('/v1/reports').send({ target_type: 'post', target_id: id, reason_code: 'spam' }).expect(201);
        await report(byOwner.id);
        await report(byMember.id);

        const queue = (await alice.agent.get('/v1/communities/lounge/mod-queue')).body.items;
        expect(queue.map((item: { target_id: string }) => item.target_id)).toEqual([byMember.id]);
        const rows = await prisma.report.findMany({ where: { target_id: byOwner.id } });
        expect(rows[0].community_id).toBeNull();

        const { agent: staff } = await signInStaff('sam', 'owner');
        const site = (await staff.get('/v1/admin/queue')).body.items.map((item: { target_id: string }) => item.target_id);
        expect(site).toEqual(expect.arrayContaining([byOwner.id, byMember.id]));
    });
});

describe('admin alerts', () => {
    it('emails at most once per 10 minutes, only for something new, and can be turned off', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        const { agent: staff, account } = await signInStaff('sam', 'owner');
        const sent = () => devOutbox.filter((mail) => mail.to === account.email && mail.subject.startsWith('Admin queue')).length;
        const before = sent();

        await sendStaffAlerts();
        expect(sent()).toBe(before);

        await bob.agent.post('/v1/reports').send({ target_type: 'post', target_id: post.id, reason_code: 'spam' }).expect(201);
        await sendStaffAlerts();
        expect(sent()).toBe(before + 1);

        await prisma.report.updateMany({ data: { created_at: new Date(Date.now() + 1000) } });
        await sendStaffAlerts(new Date(Date.now() + 5000));
        expect(sent()).toBe(before + 1);
        await sendStaffAlerts(new Date(Date.now() + 11 * 60 * 1000));
        expect(sent()).toBe(before + 2);

        await staff.put('/v1/admin/auth/alerts').send({ email: false }).expect(200);
        await prisma.report.updateMany({ data: { created_at: new Date(Date.now() + 3600000) } });
        await sendStaffAlerts(new Date(Date.now() + 2 * 3600000));
        expect(sent()).toBe(before + 2);
    });
});
