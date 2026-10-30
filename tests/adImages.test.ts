import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import * as linkPreview from '../src/lib/linkPreview';
import { api, createCommunity, createPost, signInStaff, signUp } from './helpers';

// Ad pictures: kept in their own shape with a focal point and fit, the destination's preview image as a fallback
// (copied into our storage), and ads that run both in feeds and between comments

const picture = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: '#2266cc' } }).png().toBuffer();

afterEach(() => {
    vi.restoreAllMocks();
    env.LINK_PREVIEWS_ENABLED = false;
});

async function adminWithCampaign() {
    const { agent } = await signInStaff('ads_admin');
    const advertiser = await agent.post('/v1/admin/ads/advertisers').send({ name: 'Cardernir', website: 'https://cardernir.example' });
    const campaign = await agent
        .post('/v1/admin/ads/campaigns')
        .send({ advertiser_id: advertiser.body.advertiser.id, name: 'Launch', status: 'active' });
    return { agent, campaignId: campaign.body.campaign.id as string };
}

describe('ad pictures', () => {
    it('keeps an uploaded picture in its own shape instead of cutting it to the card', async () => {
        const { agent } = await signInStaff('ads_admin');
        const tall = await agent.post('/v1/admin/images?purpose=ad_image').set('Content-Type', 'image/png').send(await picture(900, 1200));
        expect(tall.status).toBe(201);
        expect(tall.body.image).toMatchObject({ width: 900, height: 1200 });
        expect(tall.body.image.variants.map((variant: { width: number }) => variant.width)).toEqual([900, 450]);
    });

    it('serves the focal point and fit, and an "any" ad in both the feed and between comments', async () => {
        const { agent, campaignId } = await adminWithCampaign();
        const ad = await agent.post(`/v1/admin/ads/campaigns/${campaignId}/creatives`).send({
            format: 'any',
            headline: 'Learn French words',
            click_url: 'https://cardernir.example',
            image_url: 'https://cdn.cardernir.example/card.png',
            image_focus_x: 30,
            image_focus_y: 80,
            image_fit: 'contain',
        });
        expect(ad.status).toBe(201);

        const owner = await signUp('owner');
        await createCommunity(owner.agent, 'lounge');
        const post = await createPost(owner.agent, 'lounge');
        for (const query of ['placement=feed', `placement=thread&post=${post.short_id}`]) {
            const { body } = await api().get(`/v1/ads?${query}&count=1`);
            expect(body.ads[0]).toMatchObject({
                id: ad.body.creative.id,
                creative: { image_url: 'https://cdn.cardernir.example/card.png', image_focus: { x: 30, y: 80 }, image_fit: 'contain' },
            });
        }
        const bad = await agent.patch(`/v1/admin/ads/creatives/${ad.body.creative.id}`).send({ image_focus_x: 101 });
        expect(bad.status).toBe(400);
    });

    it("uses the destination's preview image, copied into our storage, unless switched off", async () => {
        env.LINK_PREVIEWS_ENABLED = true;
        const preview = vi.spyOn(linkPreview, 'fetchLinkPreview').mockResolvedValue({ image: 'https://cardernir.example/og.png' });
        vi.spyOn(linkPreview, 'fetchPublicImage').mockResolvedValue(await picture(1200, 630));
        const { agent, campaignId } = await adminWithCampaign();

        const ad = await agent
            .post(`/v1/admin/ads/campaigns/${campaignId}/creatives`)
            .send({ format: 'feed_post', headline: 'Learn French words', click_url: 'https://cardernir.example' });
        expect(ad.status).toBe(201);
        expect(preview).toHaveBeenCalledWith('https://cardernir.example');
        const stored = ad.body.creative.link_image_url as string;
        expect(stored).toMatch(/\/img\/ad_image\/.+\.webp$/);
        expect(stored).not.toContain('cardernir.example');

        const served = await api().get('/v1/ads?placement=feed&count=1');
        expect(served.body.ads[0].creative.image_url).toBe(stored);

        // Switched off: text only
        await agent.patch(`/v1/admin/ads/creatives/${ad.body.creative.id}`).send({ use_link_image: false });
        expect((await api().get('/v1/ads?placement=feed&count=1')).body.ads[0].creative.image_url).toBeNull();

        // A new destination drops the old preview image and looks again; nothing found means no picture
        await agent.patch(`/v1/admin/ads/creatives/${ad.body.creative.id}`).send({ use_link_image: true });
        preview.mockResolvedValue(null);
        const moved = await agent.patch(`/v1/admin/ads/creatives/${ad.body.creative.id}`).send({ click_url: 'https://other.example' });
        expect(moved.body.creative).toMatchObject({ link_image_url: null });
        expect(moved.body.creative.link_image_checked_at).not.toBeNull();

        // Asking again picks it up once the site has one
        preview.mockResolvedValue({ image: 'https://other.example/og.png' });
        const refreshed = await agent.post(`/v1/admin/ads/creatives/${ad.body.creative.id}/link-image`);
        expect(refreshed.status).toBe(200);
        expect(refreshed.body.creative.link_image_url).toMatch(/\.webp$/);
    });
});

describe('ads overview', () => {
    it('gives each campaign its placements and the last 7 days next to all-time totals', async () => {
        const prisma = (await import('../src/prismaConnection')).default;
        const { addDays, lagosDay } = await import('../src/lib/days');
        const { agent, campaignId } = await adminWithCampaign();
        const ad = await agent
            .post(`/v1/admin/ads/campaigns/${campaignId}/creatives`)
            .send({ format: 'thread_comment', headline: 'Learn French words', click_url: 'https://cardernir.example' });
        const at = (day: string) => new Date(`${day}T00:00:00Z`);
        await prisma.adDailyStat.createMany({
            data: [
                { creative_id: ad.body.creative.id, date: at(lagosDay()), impressions: 30, clicks: 3 },
                { creative_id: ad.body.creative.id, date: at(addDays(lagosDay(), -10)), impressions: 100, clicks: 5 },
            ],
        });

        const { body } = await agent.get('/v1/admin/ads');
        const campaign = body.advertisers[0].campaigns[0];
        expect(campaign).toMatchObject({
            impressions: 130,
            clicks: 8,
            last_7_days: { impressions: 30, clicks: 3 },
            placements: { feed: false, comments: true },
        });
    });
});
