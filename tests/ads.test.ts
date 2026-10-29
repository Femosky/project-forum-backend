import { afterEach, describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { env } from '../src/config/env';
import { decideAds } from '../src/modules/ads/decision';
import { Agent, api, createCommunity, createPost, signUp, signInStaff } from './helpers';

// Phase 6: the ad decision service, brand safety, frequency caps, budgets, impressions and clicks, the
// advertiser stats page, admin campaign management and ad reports

const ADSENSE = { ADSENSE_ENABLED: true, ADSENSE_CLIENT_ID: 'ca-pub-1234567890123456', ADSENSE_FEED_SLOT: '111', ADSENSE_THREAD_SLOT: '222' };
const original = { ...env };

afterEach(() => {
    for (const key of Object.keys(ADSENSE) as (keyof typeof ADSENSE)[]) delete env[key];
    Object.assign(env, original);
});

async function setup() {
    // Staff run the ads; a forum account owns the communities (staff accounts can't post)
    const admin = await signInStaff('adminy');
    const owner = await signUp('owner');
    await createCommunity(owner.agent, 'lagosjobs', { category: 'careers' });
    await createCommunity(owner.agent, 'cooking', { category: 'food' });
    return { ...admin, owner };
}

async function campaign(agent: Agent, fields: Record<string, unknown> = {}, creative: Record<string, unknown> = {}) {
    const advertiser = await agent.post('/v1/admin/ads/advertisers').send({ name: 'Acme Bank', website: 'https://acme.example' });
    expect(advertiser.status).toBe(201);
    const created = await agent
        .post('/v1/admin/ads/campaigns')
        .send({ advertiser_id: advertiser.body.advertiser.id, name: 'Launch', status: 'active', ...fields });
    expect(created.status).toBe(201);
    const ad = await agent
        .post(`/v1/admin/ads/campaigns/${created.body.campaign.id}/creatives`)
        .send({ format: 'feed_post', headline: 'Open an account in five minutes', click_url: 'https://acme.example/open', ...creative });
    expect(ad.status).toBe(201);
    return { campaign: created.body.campaign, creative: ad.body.creative };
}

const feedAds = (query: string) => api().get(`/v1/ads?placement=feed&${query}`);

describe('decision service', () => {
    it('returns nothing until something is switched on', async () => {
        await setup();
        const response = await feedAds('count=3');
        expect(response.status).toBe(200);
        expect(response.body.ads).toEqual([]);
        expect(response.headers['cache-control']).toContain('no-store');
    });

    it('fills slots with AdSense when the flag is on, and a direct campaign replaces it for its community', async () => {
        const admin = await setup();
        Object.assign(env, ADSENSE);

        const before = await feedAds('community=lagosjobs&count=2');
        expect(before.body.ads.map((ad: { kind: string }) => ad.kind)).toEqual(['adsense', 'adsense']);
        expect(before.body.ads[0]).toMatchObject({ client: ADSENSE.ADSENSE_CLIENT_ID, slot_id: '111', format: 'in-feed' });

        const { creative } = await campaign(admin.agent, { targeting: { communities: ['lagosjobs'] } });
        const after = await feedAds('community=lagosjobs&count=2');
        expect(after.body.ads.map((ad: { kind: string }) => ad.kind)).toEqual(['direct', 'adsense']);
        expect(after.body.ads[0]).toMatchObject({
            id: creative.id,
            creative: { advertiser_name: 'Acme Bank', title: 'Open an account in five minutes', cta_label: 'Learn more', display_url: 'acme.example' },
        });

        // Targeted elsewhere: other communities and the home feed keep AdSense
        expect((await feedAds('community=cooking&count=1')).body.ads[0].kind).toBe('adsense');
        expect((await feedAds('count=1')).body.ads[0].kind).toBe('adsense');
    });

    it('targets by category, runs untargeted campaigns everywhere, and puts direct before house', async () => {
        const admin = await setup();
        await campaign(admin.agent, { kind: 'house', name: 'Start a community' }, { headline: 'Start your own community' });
        await campaign(admin.agent, { targeting: { categories: ['careers'] } });

        const careers = await feedAds('community=lagosjobs&count=3');
        expect(careers.body.ads.map((ad: { kind: string }) => ad.kind)).toEqual(['direct', 'house']);
        const food = await feedAds('community=cooking&count=3');
        expect(food.body.ads.map((ad: { kind: string }) => ad.kind)).toEqual(['house']);
    });

    it('skips paused, future, expired and draft campaigns and paused creatives', async () => {
        const admin = await setup();
        const { campaign: running, creative } = await campaign(admin.agent);
        expect((await feedAds('count=1')).body.ads).toHaveLength(1);

        await admin.agent.patch(`/v1/admin/ads/creatives/${creative.id}`).send({ is_active: false }).expect(200);
        expect((await feedAds('count=1')).body.ads).toHaveLength(0);
        await admin.agent.patch(`/v1/admin/ads/creatives/${creative.id}`).send({ is_active: true }).expect(200);

        for (const fields of [
            { status: 'paused' },
            { status: 'draft' },
            { status: 'active', starts_at: new Date(Date.now() + 86_400_000).toISOString() },
            { status: 'active', starts_at: null, ends_at: new Date(Date.now() - 1000).toISOString() },
        ]) {
            await admin.agent.patch(`/v1/admin/ads/campaigns/${running.id}`).send(fields).expect(200);
            expect((await feedAds('count=1')).body.ads).toHaveLength(0);
        }
    });

    it('keeps ads off NSFW and sensitive communities unless an admin switches them on', async () => {
        const admin = await setup();
        await createCommunity(admin.owner.agent, 'afterdark', { is_nsfw: true });
        await createCommunity(admin.owner.agent, 'griefsupport', { category: 'health' });
        await campaign(admin.agent);

        expect((await feedAds('community=afterdark&count=1')).body.ads).toHaveLength(0);
        expect((await feedAds('community=griefsupport&count=1')).body.ads).toHaveLength(0);
        expect((await feedAds('community=cooking&count=1')).body.ads).toHaveLength(1);

        await admin.agent.patch('/v1/admin/communities/griefsupport/ads').send({ ads_enabled: true }).expect(200);
        expect((await feedAds('community=griefsupport&count=1')).body.ads).toHaveLength(1);
        await admin.agent.patch('/v1/admin/communities/cooking/ads').send({ ads_enabled: false }).expect(200);
        expect((await feedAds('community=cooking&count=1')).body.ads).toHaveLength(0);
    });

    it('serves thread ads only on active, safe threads', async () => {
        const admin = await setup();
        Object.assign(env, ADSENSE);
        await campaign(admin.agent, {}, { format: 'thread_comment' });
        const post = await createPost(admin.owner.agent, 'cooking', { title: 'Best jollof rice method', body: 'Share yours' });

        const ok = await api().get(`/v1/ads?placement=thread&post=${post.short_id}&count=2`);
        expect(ok.body.ads.map((ad: { kind: string }) => ad.kind)).toEqual(['direct', 'adsense']);
        expect(ok.body.ads[1]).toMatchObject({ slot_id: '222', format: 'in-article' });
        // Thread creatives never show in the feed
        expect((await feedAds('community=cooking&count=1')).body.ads[0].kind).toBe('adsense');

        await prisma.post.update({ where: { id: post.id }, data: { status: 'locked' } });
        expect((await api().get(`/v1/ads?placement=thread&post=${post.id}`)).body.ads).toEqual([]);
        expect((await api().get('/v1/ads?placement=thread')).status).toBe(400);
    });

    it('applies the frequency cap from the seen counts', async () => {
        const admin = await setup();
        const { campaign: capped } = await campaign(admin.agent, { frequency_cap: 2 });
        expect((await feedAds(`seen=${capped.id}:1`)).body.ads).toHaveLength(1);
        expect((await feedAds(`seen=${capped.id}:2`)).body.ads).toHaveLength(0);
        expect((await feedAds('seen=garbage,also:bad')).body.ads).toHaveLength(1);
    });

    it('stops a CPM campaign once its budget is spent', async () => {
        const admin = await setup();
        // 1,000 naira per thousand impressions, 10 naira budget: ten impressions
        const { creative } = await campaign(admin.agent, { pricing_model: 'cpm', price_minor: 100_000, budget_minor: 1_000 });
        await api().post('/v1/ads/events').send({ impressions: Array(5).fill(creative.id) }).expect(202);
        expect((await feedAds('count=1')).body.ads).toHaveLength(1);
        await api().post('/v1/ads/events').send({ impressions: Array(5).fill(creative.id) }).expect(202);
        expect((await feedAds('count=1')).body.ads).toHaveLength(0);
    });
});

describe('impressions, clicks and stats', () => {
    it('counts impressions and clicks into the daily stats and shows them on the stats page', async () => {
        const admin = await setup();
        const { campaign: running, creative } = await campaign(admin.agent);

        // Plain-text JSON, as the browser sends it with keepalive
        await api().post('/v1/ads/events').set('Content-Type', 'text/plain').send(JSON.stringify({ impressions: [creative.id, creative.id] })).expect(202);
        await api().post('/v1/ads/events').send({ impressions: [creative.id, '00000000-0000-7000-8000-000000000000'] }).expect(202);
        expect((await api().post('/v1/ads/events').send({ impressions: ['nope'] })).status).toBe(400);

        const click = await api().get(`/v1/ads/click/${creative.id}`);
        expect(click.status).toBe(302);
        expect(click.headers.location).toBe('https://acme.example/open');
        expect((await api().get('/v1/ads/click/00000000-0000-7000-8000-000000000000')).status).toBe(404);

        const [stat] = await prisma.adDailyStat.findMany();
        expect(stat).toMatchObject({ impressions: 3, clicks: 1 });

        const detail = await admin.agent.get(`/v1/admin/ads/campaigns/${running.id}`);
        expect(detail.body.creatives[0]).toMatchObject({ impressions: 3, clicks: 1 });
        expect(detail.body.days).toHaveLength(1);

        const stats = await api().get(`/v1/ads/stats/${running.stats_token}`);
        expect(stats.status).toBe(200);
        expect(stats.body).toMatchObject({ campaign: { name: 'Launch', advertiser: 'Acme Bank' }, totals: { impressions: 3, clicks: 1 } });
        expect(stats.body.campaign.budget_minor).toBeUndefined();
        expect((await api().get('/v1/ads/stats/not-a-real-token-at-all-xx')).status).toBe(404);
    });
});

describe('admin campaign management', () => {
    it('is for staff with an ads role only', async () => {
        await setup();
        const user = await signUp('regular');
        expect((await user.agent.get('/v1/admin/ads')).status).toBe(401);
        const moderator = await signInStaff('mod', 'moderator');
        expect((await moderator.agent.get('/v1/admin/ads')).status).toBe(403);
        const adsManager = await signInStaff('adsy', 'ads');
        expect((await adsManager.agent.get('/v1/admin/ads')).status).toBe(200);
        expect((await adsManager.agent.get('/v1/admin/queue')).status).toBe(403);
        expect((await api().get('/v1/admin/ads')).status).toBe(401);
    });

    it('validates targeting, dates and links, and lists campaigns with totals', async () => {
        const admin = await setup();
        const advertiser = (await admin.agent.post('/v1/admin/ads/advertisers').send({ name: 'Acme' })).body.advertiser;
        const base = { advertiser_id: advertiser.id, name: 'Bad' };
        expect((await admin.agent.post('/v1/admin/ads/campaigns').send({ ...base, targeting: { communities: ['nowhere'] } })).body.error.code).toBe('unknown_community');
        expect((await admin.agent.post('/v1/admin/ads/campaigns').send({ ...base, targeting: { categories: ['spaceships'] } })).body.error.code).toBe('unknown_category');
        expect(
            (await admin.agent.post('/v1/admin/ads/campaigns').send({ ...base, starts_at: '2026-11-02', ends_at: '2026-11-01' })).body.error.code
        ).toBe('invalid_dates');

        const created = await admin.agent.post('/v1/admin/ads/campaigns').send({ advertiser_id: advertiser.id, name: 'Good', paid: true });
        expect(created.body.campaign).toMatchObject({ status: 'draft', currency: 'NGN', targeting: { communities: [], categories: [] } });
        expect(created.body.campaign.paid_at).not.toBeNull();
        const bad = await admin.agent
            .post(`/v1/admin/ads/campaigns/${created.body.campaign.id}/creatives`)
            .send({ format: 'feed_post', headline: 'Hello there', click_url: 'javascript:alert(1)' });
        expect(bad.status).toBe(400);

        const list = await admin.agent.get('/v1/admin/ads');
        expect(list.body.adsense).toEqual({ enabled: false, configured: false });
        expect(list.body.advertisers[0].campaigns[0]).toMatchObject({ name: 'Good', creative_count: 0, impressions: 0, clicks: 0 });
    });
});

describe('reporting ads', () => {
    it('sends ad reports to the site queue and pausing the ad resolves them', async () => {
        const admin = await setup();
        const { creative } = await campaign(admin.agent);
        const reader = await signUp('reader');

        await reader.agent.post('/v1/reports').send({ target_type: 'ad', target_id: creative.id, reason_code: 'scam' }).expect(201);
        const queue = await admin.agent.get('/v1/admin/queue');
        expect(queue.body.items).toHaveLength(1);
        expect(queue.body.items[0]).toMatchObject({ target_type: 'ad', ad: { headline: creative.headline, advertiser: 'Acme Bank', is_active: true } });

        await admin.agent.patch(`/v1/admin/ads/creatives/${creative.id}`).send({ is_active: false }).expect(200);
        expect((await admin.agent.get('/v1/admin/queue')).body.items).toHaveLength(0);
    });
});

describe('house ads with a share of slots', () => {
    it('lets the site promote its own product even when paid campaigns fill every slot', async () => {
        const admin = await setup();
        const paid = await campaign(admin.agent, { priority: 10 }, { headline: 'Paid ad number one' });
        const paidTwo = await campaign(admin.agent, { priority: 10 }, { headline: 'Paid ad number two' });
        const house = await campaign(admin.agent, { kind: 'house', house_share: 30, frequency_cap: 2 }, { headline: 'Try Cardernir, our app' });
        expect(house.campaign.house_share).toBe(30);
        expect((await admin.agent.patch(`/v1/admin/ads/campaigns/${house.campaign.id}`).send({ house_share: 80 })).status).toBe(400);

        const cooking = await prisma.community.findUniqueOrThrow({ where: { name: 'cooking' } });
        const decide = (rolls: number[], seen = new Map<string, number>()) => {
            let index = 0;
            return decideAds({ placement: 'feed', community: cooking, count: 2, seen, random: () => rolls[index++ % rolls.length] });
        };
        // Rolls are taken for the shuffle (three candidates) and then one per slot: 0.9 = paid, 0.1 = under 30%
        const ids = async (rolls: number[], seen?: Map<string, number>) => (await decide(rolls, seen)).map((ad) => ad.id);
        expect(await ids([0.5, 0.5, 0.5, 0.9, 0.9])).toEqual(expect.arrayContaining([paid.creative.id, paidTwo.creative.id]));
        expect((await ids([0.5, 0.5, 0.5, 0.1, 0.9]))[0]).toBe(house.creative.id);
        // Shown once per page, and frequency caps still apply
        expect((await ids([0.5, 0.5, 0.5, 0.1, 0.1])).filter((id) => id === house.creative.id)).toHaveLength(1);
        expect(await ids([0.5, 0.5, 0.5, 0.1, 0.1], new Map([[house.campaign.id, 2]]))).not.toContain(house.creative.id);

        // Brand safety too: no ads at all on NSFW communities
        const spicy = { ...cooking, is_nsfw: true };
        expect(await decideAds({ placement: 'feed', community: spicy, count: 2, seen: new Map(), random: () => 0 })).toEqual([]);

        // House impressions are kept apart from paid ones in the daily stats
        await api().post('/v1/ads/events').send({ impressions: [house.creative.id, paid.creative.id] });
        const stats = await admin.agent.get('/v1/admin/stats?days=1');
        expect(stats.body.today).toMatchObject({ ad_impressions: 1, house_impressions: 1 });
    });
});

describe('ad destinations', () => {
    it('shows links to this site as the site itself and sends clicks to WEB_URL, never to localhost', async () => {
        const admin = await setup();
        const local = await campaign(admin.agent, { kind: 'house' }, { headline: 'Start a community today', click_url: 'http://localhost:3000/communities?new=1' });
        const relative = await campaign(admin.agent, { kind: 'house' }, { headline: 'Start a community now', click_url: '/communities' });
        const ads = (await feedAds('community=cooking&count=3')).body.ads as { id: string; creative: { display_url: string | null } }[];
        const byId = new Map(ads.map((ad) => [ad.id, ad]));
        expect(byId.get(local.creative.id)!.creative.display_url).toBeNull();
        expect(byId.get(relative.creative.id)!.creative.display_url).toBeNull();

        const click = await api().get(`/v1/ads/click/${local.creative.id}`);
        expect(click.headers.location).toBe(`${env.WEB_URL}/communities?new=1`);
        expect((await api().get(`/v1/ads/click/${relative.creative.id}`)).headers.location).toBe(`${env.WEB_URL}/communities`);
    });

    it('accepts only public https links in production', async () => {
        const admin = await setup();
        const advertiser = await admin.agent.post('/v1/admin/ads/advertisers').send({ name: 'Local Test' });
        const created = await admin.agent
            .post('/v1/admin/ads/campaigns')
            .send({ advertiser_id: advertiser.body.advertiser.id, name: 'Check', status: 'active' });
        const add = (click_url: string) =>
            admin.agent.post(`/v1/admin/ads/campaigns/${created.body.campaign.id}/creatives`).send({ format: 'feed_post', headline: 'Checking links', click_url });

        Object.assign(env, { IS_PRODUCTION: true });
        for (const bad of ['http://localhost:3000/x', 'https://127.0.0.1/x', 'https://192.168.1.4/x', 'https://printer.local/x', 'http://acme.example/x', '//evil.example/x', 'javascript:alert(1)']) {
            expect((await add(bad)).status, bad).toBe(400);
        }
        expect((await add('https://acme.example/offer')).status).toBe(201);
        expect((await add('/communities')).status).toBe(201);
        expect((await admin.agent.post('/v1/admin/ads/advertisers').send({ name: 'Bad', website: 'http://localhost:3000' })).status).toBe(400);
    });
});
