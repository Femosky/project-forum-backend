import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { addDays, lagosDay, lagosDayBounds } from '../src/lib/days';
import { ACTIVE_EVERY_MS, flushMetrics, recordActivity, recordPostView } from '../src/modules/metrics/buffer';
import { dayTotals, ensureDailyStats, writeDailyStats } from '../src/modules/metrics/stats';
import { api, createComment, createCommunity, createPost, signUp } from './helpers';

const BROWSER = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';

describe('lagos days', () => {
    it('runs on UTC+1', () => {
        expect(lagosDay(new Date('2026-10-28T22:59:00Z'))).toBe('2026-10-28');
        expect(lagosDay(new Date('2026-10-28T23:00:00Z'))).toBe('2026-10-29');
        expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
        expect(lagosDayBounds('2026-10-29').start.toISOString()).toBe('2026-10-28T23:00:00.000Z');
    });
});

describe('batched view counts', () => {
    it('buffers views in memory and writes them in one flush, skipping bots, the author and other threads', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        const other = await createPost(alice.agent, 'lounge');
        const aliceComment = await createComment(alice.agent, post.id, { body: 'from alice' });
        const bobComment = await createComment(bob.agent, post.id, { body: 'from bob' });
        const elsewhere = await createComment(bob.agent, other.id, { body: 'other thread' });

        const view = (agent: ReturnType<typeof api> | typeof bob.agent, ua = BROWSER) =>
            agent
                .post(`/v1/posts/${post.short_id}/view`)
                .set('User-Agent', ua)
                .send({ comment_ids: [aliceComment.id, bobComment.id, elsewhere.id] });

        expect((await view(api())).status).toBe(204);
        await view(api());
        await view(bob.agent);
        await view(alice.agent);
        await view(api(), 'WhatsApp/2.23');
        await view(api(), 'Googlebot/2.1');

        // Nothing is written until the flush
        expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).view_count).toBe(0);
        await flushMetrics();

        const views = async (id: string) => (await prisma.comment.findUniqueOrThrow({ where: { id } })).view_count;
        // Two guests and bob; alice's own visit doesn't count
        expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).view_count).toBe(3);
        // alice's comment: guests and bob; bob's comment: guests and alice
        expect(await views(aliceComment.id)).toBe(3);
        expect(await views(bobComment.id)).toBe(3);
        // A comment from another thread can't be counted from this page
        expect(await views(elsewhere.id)).toBe(0);

        // Additive: a second flush adds to what's there (as several API instances would)
        await view(api());
        await flushMetrics();
        expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).view_count).toBe(4);
    });

    it('puts counts back when a flush fails', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        recordPostView({ id: post.id, author_id: alice.user.id }, [], null);
        await prisma.$executeRawUnsafe('ALTER TABLE "Post" RENAME COLUMN "view_count" TO "view_count_x"');
        try {
            await flushMetrics();
        } finally {
            await prisma.$executeRawUnsafe('ALTER TABLE "Post" RENAME COLUMN "view_count_x" TO "view_count"');
        }
        await flushMetrics();
        expect((await prisma.post.findUniqueOrThrow({ where: { id: post.id } })).view_count).toBe(1);
    });
});

describe('activity and visitors', () => {
    it('updates last_active_at at most every 15 minutes and counts each account once a day', async () => {
        const alice = await signUp('alice');
        await alice.agent.get('/v1/auth/me');
        await alice.agent.get('/v1/auth/me');
        await flushMetrics();
        const first = (await prisma.user.findUniqueOrThrow({ where: { id: alice.user.id } })).last_active_at;
        expect(first).toBeTruthy();
        expect(await prisma.dailyActiveUser.count()).toBe(1);

        // Within 15 minutes nothing is queued again
        await prisma.user.update({ where: { id: alice.user.id }, data: { last_active_at: null } });
        recordActivity(alice.user.id);
        await flushMetrics();
        expect((await prisma.user.findUniqueOrThrow({ where: { id: alice.user.id } })).last_active_at).toBeNull();

        // Later it is
        recordActivity(alice.user.id, Date.now() + ACTIVE_EVERY_MS + 1000);
        await flushMetrics();
        expect((await prisma.user.findUniqueOrThrow({ where: { id: alice.user.id } })).last_active_at).toBeTruthy();
        expect(await prisma.dailyActiveUser.count()).toBe(1);
    });

    it('counts unique visitors and page views per day and per community, without storing IPs or counting bots', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const visit = (path: string, ip: string, ua = BROWSER, headers: Record<string, string> = {}) =>
            api()
                .post('/v1/metrics/visit')
                .set('User-Agent', ua)
                .set('X-Forwarded-For', ip)
                .set(headers)
                .set('Content-Type', 'text/plain')
                .send(JSON.stringify({ path }));

        expect((await visit('/', '203.0.113.1', BROWSER, { 'X-Vercel-IP-Country': 'NG' })).status).toBe(204);
        await visit('/c/lounge', '203.0.113.1');
        await visit('/c/lounge/abc12345/some-post', '203.0.113.2');
        await visit('/trending', '203.0.113.3', 'Mozilla/5.0 (iPhone)', { 'CF-IPCountry': 'gb' });
        await visit('/c/lounge', '203.0.113.4', 'Bingbot/2.0');
        await visit('/c/unknown_place', '203.0.113.2');
        expect((await visit('not-a-path', '203.0.113.2')).status).toBe(400);
        await flushMetrics();

        const visitors = await prisma.dailyVisitor.findMany({ orderBy: { country: 'asc' } });
        expect(visitors).toHaveLength(3);
        expect(visitors.map((row) => row.country)).toEqual(['GB', 'NG', null]);
        // Hashes, never addresses
        expect(JSON.stringify(visitors)).not.toContain('203.0.113');
        expect((await prisma.dailyTraffic.findFirstOrThrow()).page_views).toBe(5);
        expect((await prisma.communityDailyTraffic.findFirstOrThrow()).page_views).toBe(2);
        expect(await prisma.communityDailyVisitor.count()).toBe(2);

        const totals = await dayTotals(lagosDay());
        expect(totals).toMatchObject({ unique_visitors: 3, page_views: 5, countries: { NG: 1, GB: 1, unknown: 1 } });
    });
});

describe('daily stats', () => {
    it('snapshots a day, per community too, and fills missing days on demand', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        await createComment(bob.agent, post.id, { body: 'hello' });
        await bob.agent.put(`/v1/posts/${post.id}/vote`).send({ value: 1 });
        await bob.agent.get('/v1/auth/me');
        await flushMetrics();

        // Everything above happened "yesterday"
        const yesterday = addDays(lagosDay(), -1);
        const at = new Date(lagosDayBounds(yesterday).start.getTime() + 60 * 60 * 1000);
        await prisma.$executeRaw`UPDATE "Post" SET "created_at" = ${at.toISOString().replace('T', ' ').replace('Z', '')}::timestamp`;
        await prisma.$executeRaw`UPDATE "Comment" SET "created_at" = ${at.toISOString().replace('T', ' ').replace('Z', '')}::timestamp`;
        await prisma.$executeRaw`UPDATE "PostVote" SET "created_at" = ${at.toISOString().replace('T', ' ').replace('Z', '')}::timestamp`;
        await prisma.$executeRaw`UPDATE "CommunityMember" SET "joined_at" = ${at.toISOString().replace('T', ' ').replace('Z', '')}::timestamp`;
        await prisma.$executeRaw`UPDATE "DailyActiveUser" SET "date" = ${yesterday}::date`;

        await writeDailyStats(yesterday);
        const day = await prisma.dailyStat.findFirstOrThrow();
        expect(day).toMatchObject({ total_users: 2, posts: 1, comments: 1, votes: 1, dau: 2, wau: 2, mau: 2 });
        const lounge = await prisma.communityDailyStat.findFirstOrThrow();
        expect(lounge).toMatchObject({ posts: 1, comments: 1, votes: 1, new_members: 1 });

        // Rewriting is safe, and missing days in a range are filled
        await writeDailyStats(yesterday);
        await ensureDailyStats(addDays(yesterday, -6), yesterday);
        expect(await prisma.dailyStat.count()).toBe(7);
        expect(await prisma.communityDailyStat.count()).toBe(1);
    });

    it('serves Admin -> Stats and CSV exports to admins only', async () => {
        const admin = await signUp('boss', { admin: true });
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        await createPost(alice.agent, 'lounge');

        expect((await alice.agent.get('/v1/admin/stats')).status).toBe(403);
        expect((await api().get('/v1/admin/stats')).status).toBe(401);

        const stats = await admin.agent.get('/v1/admin/stats?days=7');
        expect(stats.status).toBe(200);
        expect(stats.body.days).toHaveLength(7);
        expect(stats.body.today).toMatchObject({ date: lagosDay(), posts: 1, total_users: 2 });
        expect(stats.body.range.to).toBe(addDays(lagosDay(), -1));
        expect((await admin.agent.get('/v1/admin/stats?from=2026-10-10&to=2026-10-01')).status).toBe(400);

        const csv = await admin.agent.get('/v1/admin/stats/export?days=3');
        expect(csv.headers['content-type']).toContain('text/csv');
        const lines = csv.text.trim().split('\n');
        expect(lines[0]).toMatch(/^date,total_users,new_signups,dau,wau,mau,unique_visitors,page_views/);
        expect(lines).toHaveLength(4);
        expect((await admin.agent.get('/v1/admin/stats/export?days=3&kind=communities')).status).toBe(200);
    });
});
