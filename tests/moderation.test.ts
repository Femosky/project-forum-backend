import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { containsPhoneNumber, asksForPrivateContact, linkHosts } from '../src/modules/safety/filters';
import { api, createComment, createCommunity, createPost, makeModerator, PASSWORD, signUp, signInStaff } from './helpers';

// Phase 5: reports and the mod queue, automatic filters, new-account friction, mutes, shadow-bans, suspensions,
// takedowns and the blocklist

const SCAM = 'Hiring now! Earn 500k weekly from home. WhatsApp me on 0803 123 4567 to start today.';

async function setup() {
    const mod = await signUp('modsy');
    const community = await createCommunity(mod.agent, 'jobs');
    return { mod, community };
}

describe('the done-when scenario', () => {
    it('holds a new account phone-number scam, shows it in the queue, and logs the removal', async () => {
        const { mod } = await setup();
        const spammer = await signUp('spammer', { fresh: true });

        const created = await spammer.agent.post('/v1/posts').send({ community: 'jobs', title: 'Remote job opening', body: SCAM });
        expect(created.status).toBe(201);
        expect(created.body.post.status).toBe('pending');
        // The author isn't told which filter caught it
        expect(created.body.post.held_reason).toBeNull();

        // Not public, but the author can still open it
        expect((await api().get('/v1/communities/jobs/posts')).body.posts).toHaveLength(0);
        expect((await api().get(`/v1/posts/${created.body.post.id}`)).status).toBe(404);
        expect((await spammer.agent.get(`/v1/posts/${created.body.post.id}`)).status).toBe(200);
        expect((await prisma.community.findUniqueOrThrow({ where: { name: 'jobs' } })).post_count).toBe(0);

        const queue = await mod.agent.get('/v1/communities/jobs/mod-queue');
        expect(queue.status).toBe(200);
        expect(queue.body.items).toHaveLength(1);
        expect(queue.body.items[0]).toMatchObject({ target_type: 'post', held_reason: 'New account sharing a phone number' });
        expect((await mod.agent.get('/v1/communities/jobs')).body.viewer.queue_count).toBe(1);

        const removed = await mod.agent
            .post(`/v1/posts/${created.body.post.id}/moderation`)
            .send({ action: 'remove', reason: 'Job scam' });
        expect(removed.status).toBe(200);
        const log = await mod.agent.get('/v1/communities/jobs/mod-log');
        expect(log.body.actions[0]).toMatchObject({ action: 'remove_post', reason: 'Job scam', actor: { username: 'modsy' } });
        expect((await mod.agent.get('/v1/communities/jobs/mod-queue')).body.items).toHaveLength(0);
    });

    it('puts a report in the mod queue straight away, grouped by target, and closes it on removal', async () => {
        const { mod } = await setup();
        const author = await signUp('author');
        const [one, two] = [await signUp('one'), await signUp('two')];
        const post = await createPost(author.agent, 'jobs', { title: 'Questionable offer', body: 'Pay a registration fee first.' });

        expect((await one.agent.post('/v1/reports').send({ target_type: 'post', target_id: post.id, reason_code: 'scam', note: 'Fee upfront' })).status).toBe(201);
        await two.agent.post('/v1/reports').send({ target_type: 'post', target_id: post.id, reason_code: 'spam' });

        const queue = await mod.agent.get('/v1/communities/jobs/mod-queue');
        expect(queue.body.items).toHaveLength(1);
        expect(queue.body.items[0].reports).toMatchObject({ total: 2, reasons: { scam: 1, spam: 1 } });
        expect(queue.body.items[0].reports.notes[0]).toMatchObject({ note: 'Fee upfront', reporter: 'one' });
        expect(queue.body.items[0].post.id).toBe(post.id);

        await mod.agent.post(`/v1/posts/${post.id}/moderation`).send({ action: 'remove', reason: 'Advance-fee scam' });
        expect(await prisma.report.count({ where: { status: 'open' } })).toBe(0);
        expect(await prisma.report.count({ where: { status: 'resolved', resolved_by: mod.user.id } })).toBe(2);
    });

    it('accepts the new reason codes and rejects unknown ones', async () => {
        await setup();
        const author = await signUp('author');
        const reporter = await signUp('reporter');
        const post = await createPost(author.agent, 'jobs');
        for (const reason_code of ['personal_info', 'misinformation', 'violence', 'sexual']) {
            expect((await reporter.agent.post('/v1/reports').send({ target_type: 'post', target_id: post.id, reason_code })).status).toBe(201);
        }
        expect((await reporter.agent.post('/v1/reports').send({ target_type: 'post', target_id: post.id, reason_code: 'rude' })).status).toBe(400);
    });

    it('approving a held post publishes it, counts it and dismisses its reports', async () => {
        const { mod } = await setup();
        const fresh = await signUp('fresh', { fresh: true });
        const held = await fresh.agent.post('/v1/posts').send({ community: 'jobs', title: 'Call me', body: 'My line is +234 803 123 4567' });
        expect(held.body.post.status).toBe('pending');

        const approved = await mod.agent.post(`/v1/posts/${held.body.post.id}/moderation`).send({ action: 'approve' });
        expect(approved.body.post.status).toBe('active');
        expect((await api().get('/v1/communities/jobs/posts')).body.posts).toHaveLength(1);
        expect((await prisma.community.findUniqueOrThrow({ where: { name: 'jobs' } })).post_count).toBe(1);
    });
});

describe('filters', () => {
    it('recognises phone numbers, private-contact asks and links, and leaves ordinary text alone', () => {
        expect(containsPhoneNumber('Call 0803-123-4567')).toBe(true);
        expect(containsPhoneNumber('+234 (803) 123 4567')).toBe(true);
        expect(containsPhoneNumber('Rent is 1,500,000 a year since 2019-2024')).toBe(false);
        expect(asksForPrivateContact('DM me for details')).toBe(true);
        expect(asksForPrivateContact('Send me a message on WhatsApp number below')).toBe(true);
        expect(asksForPrivateContact('Is WhatsApp down for everyone?')).toBe(false);
        expect(linkHosts('see https://www.Example.com/x and bit.ly/abc but not node.js')).toEqual(['example.com', 'bit.ly']);
    });

    it("doesn't flag Pidgin or prices from a new account", async () => {
        await setup();
        const fresh = await signUp('fresh', { fresh: true });
        const post = await fresh.agent.post('/v1/posts').send({
            community: 'jobs',
            title: 'Abeg, how much be rent for Yaba now?',
            body: 'Landlord dey ask 1,500,000 per year. Na wa o, e don cost well well.',
        });
        expect(post.body.post.status).toBe('active');
    });

    it('holds link shorteners, blocklisted domains and phrases for everyone', async () => {
        await setup();
        const admin = await signInStaff('root');
        const user = await signUp('regular');

        const shortened = await createPost(user.agent, 'jobs', { title: 'Great offer', body: 'Details at bit.ly/3xYz' });
        expect((await prisma.post.findUniqueOrThrow({ where: { id: shortened.id } })).held_reason).toBe('Uses a link shortener (bit.ly)');

        expect((await admin.agent.post('/v1/admin/blocklist').send({ kind: 'domain', value: 'https://www.fastloans.example.com/apply' })).body.term.value).toBe('fastloans.example.com');
        expect((await admin.agent.post('/v1/admin/blocklist').send({ kind: 'keyword', value: 'Double your money' })).status).toBe(201);
        expect((await admin.agent.post('/v1/admin/blocklist').send({ kind: 'keyword', value: 'double your money' })).status).toBe(409);

        const domain = await createPost(user.agent, 'jobs', { type: 'link', title: 'Loans today', url: 'https://apply.fastloans.example.com/now' });
        const phrase = await createPost(user.agent, 'jobs', { title: 'Investment club', body: 'We can double your money in a week.' });
        expect((await prisma.post.findUniqueOrThrow({ where: { id: domain.id } })).held_reason).toMatch(/blocked domain/);
        expect((await prisma.post.findUniqueOrThrow({ where: { id: phrase.id } })).held_reason).toMatch(/blocked phrase/);

        const ok = await createPost(user.agent, 'jobs', { title: 'Saving tips', body: 'Is it smart to double down on savings?' });
        expect((await prisma.post.findUniqueOrThrow({ where: { id: ok.id } })).status).toBe('active');
    });

    it('holds the same post pasted into another community, and the same comment under several posts', async () => {
        const { mod } = await setup();
        await createCommunity(mod.agent, 'money');
        await createCommunity(mod.agent, 'tech');
        const user = await signUp('paster');

        const first = await createPost(user.agent, 'jobs', { title: 'Best savings account?', body: 'Which bank pays the most interest right now?' });
        const copy = await createPost(user.agent, 'money', { title: 'Best savings account?', body: 'Another body entirely here' });
        expect((await prisma.post.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('active');
        expect((await prisma.post.findUniqueOrThrow({ where: { id: copy.id } })).held_reason).toBe('Same post in another community');

        const targets = [
            await createPost(mod.agent, 'jobs', { title: 'Thread one' }),
            await createPost(mod.agent, 'money', { title: 'Thread two' }),
            await createPost(mod.agent, 'tech', { title: 'Thread three' }),
        ];
        const statuses = [];
        for (const target of targets) {
            const comment = await createComment(user.agent, target.id, { body: 'Check out my channel for daily tips!!' });
            statuses.push((await prisma.comment.findUniqueOrThrow({ where: { id: comment.id } })).status);
        }
        expect(statuses).toEqual(['active', 'active', 'pending']);
    });

    it('re-checks edits, so a clean comment edited into a scam is held', async () => {
        const { mod } = await setup();
        const fresh = await signUp('fresh', { fresh: true });
        const post = await createPost(mod.agent, 'jobs');
        const parent = await createComment(mod.agent, post.id);
        const reply = await createComment(fresh.agent, post.id, { body: 'Interested', parent_id: parent.id });
        expect((await prisma.comment.findUniqueOrThrow({ where: { id: parent.id } })).reply_count).toBe(1);

        const edit = await fresh.agent.patch(`/v1/comments/${reply.id}`).send({ body: 'Inbox me for the job' });
        expect(edit.body.comment.status).toBe('pending');
        expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).comment_count).toBe(1);
        expect((await prisma.comment.findUniqueOrThrow({ where: { id: parent.id } })).reply_count).toBe(0);

        await mod.agent.post(`/v1/comments/${reply.id}/moderation`).send({ action: 'approve' });
        expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).comment_count).toBe(2);
        expect((await prisma.comment.findUniqueOrThrow({ where: { id: parent.id } })).reply_count).toBe(1);
    });
});

describe('new-account friction', () => {
    it('blocks links and anonymity for brand-new accounts and caps how fast they post', async () => {
        await setup();
        const fresh = await signUp('fresh', { fresh: true });
        const me = await fresh.agent.get('/v1/auth/me');
        expect(me.body.user).toMatchObject({ can_post_links: false, can_post_anonymously: false });

        const link = await fresh.agent.post('/v1/posts').send({ community: 'jobs', type: 'link', title: 'My site', url: 'https://example.com' });
        expect(link.status).toBe(403);
        expect(link.body.error.code).toBe('new_account_links');
        const inline = await fresh.agent.post('/v1/posts').send({ community: 'jobs', title: 'Read this', body: 'see www.example.com' });
        expect(inline.body.error.code).toBe('new_account_links');

        const anonymous = await fresh.agent.post('/v1/posts').send({ community: 'jobs', title: 'Secret', is_anonymous: true });
        expect(anonymous.body.error.code).toBe('anonymous_not_allowed');

        for (let index = 0; index < 3; index++) await createPost(fresh.agent, 'jobs', { title: `Question number ${index}` });
        const fourth = await fresh.agent.post('/v1/posts').send({ community: 'jobs', title: 'One more question' });
        expect(fourth.status).toBe(429);
        expect(fourth.body.error.code).toBe('new_account_limit');
    });

    it('lets links through once the account has karma', async () => {
        await setup();
        const fresh = await signUp('fresh', { fresh: true });
        await prisma.user.update({ where: { id: fresh.user.id }, data: { karma: 10 } });
        expect((await fresh.agent.post('/v1/posts').send({ community: 'jobs', type: 'link', title: 'My site', url: 'https://example.com' })).status).toBe(201);
    });
});

describe('anonymous posting guardrails', () => {
    it('needs a verified email, and moderators can still see and ban the account behind an anonymous post', async () => {
        const { mod } = await setup();
        const user = await signUp('quiet');
        await prisma.user.update({ where: { id: user.user.id }, data: { email_verified_at: null } });
        expect((await user.agent.post('/v1/posts').send({ community: 'jobs', title: 'Salary question', is_anonymous: true })).status).toBe(403);
        await prisma.user.update({ where: { id: user.user.id }, data: { email_verified_at: new Date() } });

        const post = await createPost(user.agent, 'jobs', { title: 'Salary question', is_anonymous: true });
        expect((await api().get(`/v1/posts/${post.id}`)).body.post.author).toBeNull();
        expect((await mod.agent.get(`/v1/posts/${post.id}`)).body.post.author.username).toBe('quiet');

        expect((await mod.agent.post('/v1/communities/jobs/bans').send({ username: 'quiet', days: 7 })).status).toBe(200);
        expect((await user.agent.post('/v1/posts').send({ community: 'jobs', title: 'Another one', is_anonymous: true })).body.error.code).toBe('banned');
    });
});

describe('mutes', () => {
    it('stops a muted user posting and commenting while they can still read', async () => {
        const { mod } = await setup();
        const user = await signUp('loud');
        const post = await createPost(mod.agent, 'jobs');

        expect((await mod.agent.post('/v1/communities/jobs/mutes').send({ username: 'loud', days: 3, reason: 'Cool off' })).status).toBe(200);
        expect((await user.agent.post('/v1/posts').send({ community: 'jobs', title: 'Hello again' })).body.error.code).toBe('muted');
        expect((await user.agent.post(`/v1/posts/${post.id}/comments`).send({ body: 'hi' })).body.error.code).toBe('muted');
        expect((await user.agent.get(`/v1/posts/${post.id}`)).status).toBe(200);
        expect((await user.agent.get('/v1/communities/jobs')).body.viewer.muted_until).toBeTruthy();

        const restrictions = await mod.agent.get('/v1/communities/jobs/restrictions');
        expect(restrictions.body.mutes).toEqual([expect.objectContaining({ username: 'loud', reason: 'Cool off' })]);
        expect((await user.agent.get('/v1/communities/jobs/restrictions')).status).toBe(403);

        expect((await mod.agent.delete('/v1/communities/jobs/mutes/loud')).status).toBe(200);
        expect((await user.agent.post(`/v1/posts/${post.id}/comments`).send({ body: 'hi' })).status).toBe(201);
        const actions = (await mod.agent.get('/v1/communities/jobs/mod-log')).body.actions.map((row: { action: string }) => row.action);
        expect(actions).toEqual(expect.arrayContaining(['mute_user', 'unmute_user']));
    });
});

describe('admin panel', () => {
    it('is for staff accounts only: a forum account, even with the old admin role, gets nothing', async () => {
        const user = await signUp('regular');
        const oldAdmin = await signUp('oldadmin', { admin: true });
        expect((await user.agent.get('/v1/admin/queue')).status).toBe(401);
        expect((await oldAdmin.agent.get('/v1/admin/queue')).status).toBe(401);
        expect((await api().get('/v1/admin/queue')).status).toBe(401);
    });

    it('shadow-bans: the author still sees their content, nobody else does, and counts follow', async () => {
        const { mod } = await setup();
        const admin = await signInStaff('root');
        const spammer = await signUp('spammy');
        const post = await createPost(mod.agent, 'jobs');
        const before = await createComment(spammer.agent, post.id, { body: 'first' });
        const own = await createPost(spammer.agent, 'jobs', { title: 'My own thread' });

        expect((await admin.agent.post('/v1/admin/users/spammy/shadow-ban').send({ shadow_banned: true })).status).toBe(200);
        const after = await createComment(spammer.agent, post.id, { body: 'second' });

        const publicThread = await api().get(`/v1/posts/${post.id}/comments`);
        expect(publicThread.body.comments).toHaveLength(0);
        const ownThread = await spammer.agent.get(`/v1/posts/${post.id}/comments`);
        expect(ownThread.body.comments.map((comment: { id: string }) => comment.id).sort()).toEqual([before.id, after.id].sort());

        expect((await api().get(`/v1/posts/${own.id}`)).status).toBe(404);
        expect((await spammer.agent.get(`/v1/posts/${own.id}`)).status).toBe(200);
        expect((await api().get('/v1/feed?scope=all')).body.posts.map((row: { id: string }) => row.id)).toEqual([post.id]);
        expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).comment_count).toBe(0);
        expect((await prisma.community.findUniqueOrThrow({ where: { name: 'jobs' } })).post_count).toBe(1);

        await admin.agent.post('/v1/admin/users/spammy/shadow-ban').send({ shadow_banned: false });
        expect((await api().get(`/v1/posts/${post.id}/comments`)).body.comments).toHaveLength(2);
        expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).comment_count).toBe(2);
    });

    it('suspends an account (signing it out), lifts an expired suspension at sign-in, and logs both', async () => {
        const admin = await signInStaff('root');
        const user = await signUp('naughty');

        const suspended = await admin.agent.post('/v1/admin/users/naughty/suspend').send({ days: 2, reason: 'Spam' });
        expect(suspended.body.user.status).toBe('suspended');
        expect((await user.agent.get('/v1/auth/me')).status).toBe(401);
        const login = await api().post('/v1/auth/login').send({ identifier: 'naughty', password: PASSWORD });
        expect(login.status).toBe(403);
        expect(login.body.error.code).toBe('account_suspended');

        await prisma.user.update({ where: { username: 'naughty' }, data: { suspended_until: new Date(Date.now() - 1000) } });
        expect((await api().post('/v1/auth/login').send({ identifier: 'naughty', password: PASSWORD })).status).toBe(200);
        expect((await prisma.user.findUniqueOrThrow({ where: { username: 'naughty' } })).status).toBe('active');

        const log = await admin.agent.get('/v1/admin/mod-log');
        expect(log.body.actions[0]).toMatchObject({ action: 'suspend_user', reason: 'Spam', actor: null, staff: { name: 'root' } });
        expect((await admin.agent.get('/v1/admin/users?q=naug')).body.users[0].username).toBe('naughty');
    });

    it('takes a community down and restores it', async () => {
        await setup();
        const admin = await signInStaff('root');
        expect((await admin.agent.post('/v1/admin/communities/jobs/takedown').send({ reason: 'Illegal content' })).status).toBe(200);
        expect((await api().get('/v1/communities/jobs')).status).toBe(404);
        expect((await api().get('/v1/seo/status?type=community&id=jobs')).body.state).toBe('gone');
        expect((await admin.agent.post('/v1/admin/communities/jobs/restore')).status).toBe(200);
        expect((await api().get('/v1/communities/jobs')).status).toBe(200);
    });

    it('sees held content and reports from every community in one queue', async () => {
        const { mod } = await setup();
        await createCommunity(mod.agent, 'money');
        const admin = await signInStaff('root');
        const fresh = await signUp('fresh', { fresh: true });
        const reporter = await signUp('reporter');
        await fresh.agent.post('/v1/posts').send({ community: 'jobs', title: 'Job', body: SCAM });
        const post = await createPost(mod.agent, 'money', { title: 'Fine post' });
        await reporter.agent.post('/v1/reports').send({ target_type: 'post', target_id: post.id, reason_code: 'misinformation' });
        await reporter.agent.post('/v1/reports').send({ target_type: 'user', target_id: fresh.user.id, reason_code: 'scam' });

        const queue = await admin.agent.get('/v1/admin/queue');
        expect(queue.body.items.map((item: { target_type: string }) => item.target_type).sort()).toEqual(['post', 'post', 'user']);
        expect((await admin.agent.get('/v1/admin/overview')).body.queue).toBe(3);
    });
});

describe('communities directory', () => {
    it('filters by category, searches and counts categories', async () => {
        const owner = await signUp('owner');
        await createCommunity(owner.agent, 'lagoshomes', { category: 'housing', description: 'Flats and agents' });
        await createCommunity(owner.agent, 'devs', { category: 'tech', description: 'Building software' });
        await createCommunity(owner.agent, 'misc');
        expect((await owner.agent.post('/v1/communities').send({ name: 'bad_cat', category: 'nope' })).status).toBe(400);

        const housing = await api().get('/v1/communities?category=housing');
        expect(housing.body.communities.map((row: { name: string }) => row.name)).toEqual(['lagoshomes']);
        expect(housing.body.communities[0].category).toBe('housing');
        expect((await api().get('/v1/communities?q=software')).body.communities.map((row: { name: string }) => row.name)).toEqual(['devs']);

        const categories = await api().get('/v1/communities/categories');
        expect(categories.body.categories.find((row: { id: string }) => row.id === 'housing')).toEqual({ id: 'housing', label: 'Rent & Housing', count: 1 });

        await owner.agent.patch('/v1/communities/misc').send({ category: 'other' });
        expect((await api().get('/v1/communities?category=other')).body.communities).toHaveLength(1);
    });

    it('makes moderators see their queue count but nobody else', async () => {
        const { mod, community } = await setup();
        const user = await signUp('member');
        await makeModerator(user.user.id, community.id);
        expect((await user.agent.get('/v1/communities/jobs')).body.viewer.queue_count).toBe(0);
        expect((await (await signUp('outsider')).agent.get('/v1/communities/jobs')).body.viewer.queue_count).toBeNull();
        expect(mod).toBeTruthy();
    });
});
