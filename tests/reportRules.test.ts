import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { devOutbox } from '../src/lib/email';
import { sendStaffAlerts } from '../src/modules/moderation/staffAlerts';
import { createComment, createCommunity, createPost, signInStaff, signUp } from './helpers';

// Reddit-style reports: a report names a community rule (its moderators only) or a site rule (moderators and admins),
// and moderators can send a report on to the admins

const RULES = [
    { title: 'Be kind', description: '' },
    { title: 'No self-promotion', description: 'Ask first' },
];

async function setup() {
    const mod = await signUp('modsy');
    await createCommunity(mod.agent, 'lounge', { rules: RULES });
    const author = await signUp('author');
    await author.agent.put('/v1/communities/lounge/membership').send({}).expect(200);
    const post = await createPost(author.agent, 'lounge', { title: 'My shop is open' });
    const reporter = await signUp('reporter');
    const admin = await signInStaff('root', 'owner');
    return { mod, author, post, reporter, admin };
}

const ids = (response: { body: { items: { target_id: string }[] } }) => response.body.items.map((item) => item.target_id);

describe('community-rule and site-rule reports', () => {
    it('sends community-rule reports to the community only, and site-rule reports to both', async () => {
        const { mod, author, post, reporter, admin } = await setup();
        const comment = await createComment(author.agent, post.id, { body: 'Buy my things' });

        await reporter.agent.post('/v1/reports').send({ target_type: 'post', target_id: post.id, community_rule: 1, note: 'Third time' }).expect(201);
        await reporter.agent.post('/v1/reports').send({ target_type: 'comment', target_id: comment.id, reason_code: 'spam' }).expect(201);

        const row = await prisma.report.findFirstOrThrow({ where: { target_id: post.id } });
        expect(row).toMatchObject({ rule_kind: 'community', rule_title: 'No self-promotion', reason_code: 'other' });

        const queue = await mod.agent.get('/v1/communities/lounge/mod-queue');
        expect(ids(queue).sort()).toEqual([post.id, comment.id].sort());
        const postItem = queue.body.items.find((item: { target_id: string }) => item.target_id === post.id);
        expect(postItem.reports).toMatchObject({ total: 1, site: 0, rules: { 'No self-promotion': 1 }, reasons: {} });
        expect(postItem.escalation).toBeNull();

        // The admins' queue has the site-rule report only; the Reports view has both
        expect(ids(await admin.agent.get('/v1/admin/queue'))).toEqual([comment.id]);
        expect(ids(await admin.agent.get('/v1/admin/queue?view=reports')).sort()).toEqual([post.id, comment.id].sort());
        expect((await admin.agent.get('/v1/admin/overview')).body.queue).toBe(1);

        // The site queue shows whether the author is already dealt with; the community's queue doesn't
        await admin.agent.post('/v1/admin/users/author/shadow-ban').send({ shadow_banned: true }).expect(200);
        const [site] = (await admin.agent.get('/v1/admin/queue')).body.items;
        expect(site.account).toEqual({ suspended: false, shadow_banned: true });
        expect((await mod.agent.get('/v1/communities/lounge/mod-queue')).body.items[0].account).toBeUndefined();
    });

    it('rejects a missing or mixed rule, a rule the community lacks, and community rules on accounts', async () => {
        const { post, reporter, author } = await setup();
        const send = (body: object) => reporter.agent.post('/v1/reports').send({ target_type: 'post', target_id: post.id, ...body });
        expect((await send({})).status).toBe(400);
        expect((await send({ reason_code: 'spam', community_rule: 0 })).status).toBe(400);
        expect((await send({ community_rule: 5 })).status).toBe(400);
        const user = await reporter.agent.post('/v1/reports').send({ target_type: 'user', target_id: author.user.id, community_rule: 0 });
        expect(user.status).toBe(400);
    });

    it('lets a moderator send a report to the admins, once, and logs it', async () => {
        const { mod, post, reporter, admin } = await setup();
        const other = await signUp('other');
        await reporter.agent.post('/v1/reports').send({ target_type: 'post', target_id: post.id, community_rule: 0 }).expect(201);
        await other.agent.post('/v1/reports').send({ target_type: 'post', target_id: post.id, community_rule: 1 }).expect(201);
        const [item] = (await mod.agent.get('/v1/communities/lounge/mod-queue')).body.items;

        // Not a moderator here
        expect((await reporter.agent.post(`/v1/reports/${item.report_ids[0]}/escalate`).send({})).status).toBe(403);

        const escalated = await mod.agent.post(`/v1/reports/${item.report_ids[0]}/escalate`).send({ note: 'Looks like a scam ring' });
        expect(escalated.body).toEqual({ success: true, escalated: 2 });

        const siteItems = (await admin.agent.get('/v1/admin/queue')).body.items;
        expect(siteItems).toHaveLength(1);
        expect(siteItems[0].escalation).toMatchObject({ by: 'modsy', note: 'Looks like a scam ring' });
        // Still in the community's queue, marked as sent
        const again = (await mod.agent.get('/v1/communities/lounge/mod-queue')).body.items[0];
        expect(again.escalation).toMatchObject({ by: 'modsy' });
        expect((await mod.agent.post(`/v1/reports/${item.report_ids[0]}/escalate`).send({})).body.escalated).toBe(0);

        const log = await mod.agent.get('/v1/communities/lounge/mod-log');
        expect(log.body.actions[0]).toMatchObject({ action: 'escalate_reports', reason: 'Looks like a scam ring' });

        // The admins settle it, which closes it in the community's queue too
        await admin.agent.post(`/v1/admin/reports/${item.report_ids[0]}/resolve`).send({ status: 'dismissed' }).expect(200);
        expect((await mod.agent.get('/v1/communities/lounge/mod-queue')).body.items).toHaveLength(0);
        expect((await mod.agent.post(`/v1/reports/${item.report_ids[0]}/escalate`).send({})).status).toBe(400);
    });

    it('emails admins about site-rule reports and escalations, not community-rule reports', async () => {
        const { mod, post, reporter } = await setup();
        const { account } = await signInStaff('sam', 'owner');
        const sent = () => devOutbox.filter((mail) => mail.to === account.email && mail.subject.startsWith('Admin queue')).length;
        const before = sent();

        await reporter.agent.post('/v1/reports').send({ target_type: 'post', target_id: post.id, community_rule: 0 }).expect(201);
        await sendStaffAlerts();
        expect(sent()).toBe(before);

        const [item] = (await mod.agent.get('/v1/communities/lounge/mod-queue')).body.items;
        await mod.agent.post(`/v1/reports/${item.report_ids[0]}/escalate`).send({}).expect(200);
        await sendStaffAlerts(new Date(Date.now() + 1000));
        expect(sent()).toBe(before + 1);
    });
});
