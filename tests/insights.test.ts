import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { addDays, lagosDay } from '../src/lib/days';
import { flushMetrics } from '../src/modules/metrics/buffer';
import { sourceOf } from '../src/modules/metrics/sources';
import { dailyStatsJob } from '../src/modules/metrics/stats';
import { api, createCommunity, createPost, signInStaff, signUp } from './helpers';

// Post insights: daily totals per post, country and source breakdowns, shares, for the author only

const BROWSER = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';
const OTHER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';

describe('traffic sources', () => {
    it('maps referrer hosts to a fixed set of labels', () => {
        const own = ['yarnter.com'];
        expect(sourceOf(undefined, own)).toBe('Direct');
        expect(sourceOf('www.google.com.ng', own)).toBe('Google');
        expect(sourceOf('com.google.android.gm', own)).toBe('Google');
        expect(sourceOf('l.facebook.com', own)).toBe('Facebook');
        expect(sourceOf('t.co', own)).toBe('X');
        expect(sourceOf('web.whatsapp.com', own)).toBe('WhatsApp');
        expect(sourceOf('yarnter.com', own)).toBe('Yarnter');
        expect(sourceOf('someblog.example', own)).toBe('Other sites');
    });
});

describe('post insights', () => {
    it('counts views, readers, countries, sources and shares per day, for the author only', async () => {
        const alice = await signUp('alice');
        const bob = await signUp('bob');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');

        const view = (ua: string, body: object, country = 'NG') =>
            api().post(`/v1/posts/${post.id}/view`).set('User-Agent', ua).set('cf-ipcountry', country).send(body).expect(204);
        await view(BROWSER, { referrer_host: 'www.google.com' });
        await view(BROWSER, { referrer_host: 'www.google.com' });
        await view(OTHER, { referrer_host: 'wa.me' }, 'GB');
        await view(OTHER, {}, 'GB');
        // The author's own view doesn't count
        await alice.agent.post(`/v1/posts/${post.id}/view`).set('User-Agent', BROWSER).send({}).expect(204);
        await api().post(`/v1/posts/${post.id}/share`).set('User-Agent', BROWSER).expect(204);
        await api().post(`/v1/posts/${post.id}/share`).set('User-Agent', 'Googlebot/2.1').expect(204);

        expect((await bob.agent.get(`/v1/posts/${post.id}/insights`)).status).toBe(403);
        const { insights } = (await alice.agent.get(`/v1/posts/${post.id}/insights`)).body;
        expect(insights.totals).toMatchObject({ views: 4, readers: 2, shares: 1, upvote_ratio: null });
        expect(insights.days).toHaveLength(30);
        expect(insights.days.at(-1)).toEqual({ date: lagosDay(), views: 4, readers: 2, shares: 1 });
        expect(insights.countries).toHaveLength(2);
        expect(insights.countries).toEqual(expect.arrayContaining([{ key: 'GB', views: 2, share: 0.5 }, { key: 'NG', views: 2, share: 0.5 }]));
        expect(Object.fromEntries(insights.sources.map((row: { key: string; views: number }) => [row.key, row.views]))).toEqual({ Google: 2, WhatsApp: 1, Direct: 1 });

        // Admin -> Stats: sources and top posts for the range (today isn't in a default range, so ask for it)
        const staff = await signInStaff('root', 'owner');
        const stats = await staff.agent.get(`/v1/admin/stats?from=${addDays(lagosDay(), -1)}`);
        expect(stats.status).toBe(200);
        const csv = await staff.agent.get(`/v1/admin/stats/export?kind=sources&from=${addDays(lagosDay(), -1)}`);
        expect(csv.status).toBe(200);
    });

    it('prunes country and source rows after 90 days but keeps the daily totals', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const post = await createPost(alice.agent, 'lounge');
        const old = new Date(`${addDays(lagosDay(), -120)}T00:00:00Z`);
        await prisma.postDailyStat.create({ data: { post_id: post.id, date: old, views: 5 } });
        await prisma.postDailySource.create({ data: { post_id: post.id, date: old, kind: 'source', key: 'Google', views: 5 } });
        await flushMetrics();
        await dailyStatsJob.run();
        expect(await prisma.postDailySource.count({ where: { post_id: post.id } })).toBe(0);
        expect(await prisma.postDailyStat.count({ where: { post_id: post.id } })).toBe(1);
    });
});
