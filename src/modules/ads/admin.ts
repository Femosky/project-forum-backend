import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env';
import prisma from '../../prismaConnection';
import { badRequest, notFound, parse, uuidParam } from '../../lib/http';
import { AuthRequest, viewerOf } from '../../middlewares/auth';
import { COMMUNITY_CATEGORIES, LIMITS } from '../../shared/validation';
import { closeReports } from '../moderation/queue';
import { findCommunity } from '../communities/access';
import { linkProblem } from './urls';
import { campaignSpend, clearAdCache, readTargeting, targetingSchema } from './decision';

// Ad campaign management for site admins, mounted at /v1/admin/ads (the admin router has already checked the
// role). Direct deals are manual: create the advertiser, then a campaign with dates, targeting and price, then its
// creatives. Payment is a Paystack link tracked on the campaign.

const router = Router();

const webUrl = z
    .string()
    .trim()
    .max(LIMITS.URL_MAX)
    .superRefine((value, context) => {
        const problem = linkProblem(value, { allowSitePath: false });
        if (problem) context.addIssue({ code: 'custom', message: problem });
    });
// Where an ad leads: an advertiser's https link, or a page on this site ("/communities"), which is resolved
// against WEB_URL when served (ads/urls.ts)
const destinationUrl = z
    .string()
    .trim()
    .max(LIMITS.URL_MAX)
    .superRefine((value, context) => {
        const problem = linkProblem(value, { allowSitePath: true });
        if (problem) context.addIssue({ code: 'custom', message: problem });
    });
const imageUrl = webUrl.refine((value) => value.startsWith('https://'), 'Images must use https');
const optional = <T extends z.ZodType>(schema: T) => schema.nullable().optional();

const advertiserSchema = z.object({
    name: z.string().trim().min(1).max(100),
    contact_email: optional(z.email().max(254)),
    logo_url: optional(imageUrl),
    website: optional(webUrl),
    notes: optional(z.string().trim().max(2000)),
});

const campaignFields = z.object({
    name: z.string().trim().min(1).max(100),
    kind: z.enum(['direct', 'house']),
    status: z.enum(['draft', 'active', 'paused', 'ended']),
    starts_at: optional(z.coerce.date()),
    ends_at: optional(z.coerce.date()),
    targeting: targetingSchema,
    pricing_model: z.enum(['cpm', 'flat']),
    budget_minor: optional(z.number().int().min(0).max(1e12)),
    price_minor: optional(z.number().int().min(0).max(1e12)),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code like NGN'),
    frequency_cap: optional(z.number().int().min(1).max(100)),
    priority: z.number().int().min(-100).max(100),
    // House campaigns: percent of slots they take even when paid campaigns exist (decision.ts)
    house_share: z.number().int().min(0).max(50),
    payment_url: optional(webUrl),
    paid: z.boolean(),
});

const createCampaignSchema = campaignFields
    .partial()
    .required({ name: true })
    .extend({ advertiser_id: z.uuid() });
const updateCampaignSchema = campaignFields.partial();

const creativeFields = z.object({
    format: z.enum(['feed_post', 'thread_comment']),
    headline: z.string().trim().min(3).max(120),
    body: optional(z.string().trim().max(500)),
    image_url: optional(imageUrl),
    click_url: destinationUrl,
    cta_label: z.string().trim().min(2).max(24),
    is_active: z.boolean(),
});
const createCreativeSchema = creativeFields.partial({ body: true, image_url: true, cta_label: true, is_active: true });
const updateCreativeSchema = creativeFields.partial();

// Checks targeting names against real communities and categories, so a typo doesn't silently target nothing
async function validTargeting(targeting: z.infer<typeof targetingSchema>) {
    const categories = targeting.categories.filter((category) => !(category in COMMUNITY_CATEGORIES));
    if (categories.length > 0) throw badRequest(`Unknown category: ${categories.join(', ')}`, 'unknown_category');
    // Stored under each community's current name, whatever case or old name was typed
    const found = await Promise.all(targeting.communities.map((name) => findCommunity(name).catch(() => null)));
    const missing = targeting.communities.filter((_, index) => !found[index]);
    if (missing.length > 0) throw badRequest(`No community called ${missing.join(', ')}`, 'unknown_community');
    return { communities: [...new Set(found.map((community) => community!.name))], categories: [...new Set(targeting.categories)] };
}

function checkDates(starts: Date | null | undefined, ends: Date | null | undefined) {
    if (starts && ends && ends <= starts) throw badRequest('The end date must be after the start date.', 'invalid_dates');
}

type CampaignInput = z.infer<typeof updateCampaignSchema>;

async function campaignData(input: CampaignInput) {
    const { paid, targeting, ...fields } = input;
    return {
        ...fields,
        ...(targeting ? { targeting: (await validTargeting(targeting)) as Prisma.InputJsonValue } : {}),
        ...(paid === undefined ? {} : { paid_at: paid ? new Date() : null }),
    };
}

const statsTotals = async (creativeIds: string[]) => {
    const rows = creativeIds.length
        ? await prisma.adDailyStat.groupBy({ by: ['creative_id'], where: { creative_id: { in: creativeIds } }, _sum: { impressions: true, clicks: true } })
        : [];
    return new Map(rows.map((row) => [row.creative_id, { impressions: row._sum.impressions ?? 0, clicks: row._sum.clicks ?? 0 }]));
};

function campaignOut<T extends { targeting: Prisma.JsonValue }>(campaign: T) {
    return { ...campaign, targeting: readTargeting(campaign.targeting) };
}

// Everything on one screen: advertisers, their campaigns with totals, and whether AdSense is filling slots
router.get('/', async (request, response) => {
    const advertisers = await prisma.advertiser.findMany({
        orderBy: { created_at: 'desc' },
        include: {
            campaigns: {
                orderBy: { created_at: 'desc' },
                include: { creatives: { select: { id: true, is_active: true } } },
            },
        },
    });
    const campaigns = advertisers.flatMap((advertiser) => advertiser.campaigns);
    const totals = await statsTotals(campaigns.flatMap((campaign) => campaign.creatives.map((creative) => creative.id)));
    const spend = await campaignSpend(campaigns.filter((campaign) => campaign.pricing_model === 'cpm').map((campaign) => campaign.id));

    response.json({
        adsense: {
            enabled: env.ADS_ENABLED && env.ADSENSE_ENABLED,
            configured: Boolean(env.ADSENSE_CLIENT_ID && env.ADSENSE_FEED_SLOT && env.ADSENSE_THREAD_SLOT),
        },
        ads_enabled: env.ADS_ENABLED,
        advertisers: advertisers.map(({ campaigns: own, ...advertiser }) => ({
            ...advertiser,
            campaigns: own.map(({ creatives, ...campaign }) => {
                const sum = creatives.reduce(
                    (acc, creative) => {
                        const total = totals.get(creative.id);
                        return { impressions: acc.impressions + (total?.impressions ?? 0), clicks: acc.clicks + (total?.clicks ?? 0) };
                    },
                    { impressions: 0, clicks: 0 }
                );
                return {
                    ...campaignOut(campaign),
                    creative_count: creatives.length,
                    active_creatives: creatives.filter((creative) => creative.is_active).length,
                    ...sum,
                    spent_minor: campaign.pricing_model === 'cpm' ? (spend.get(campaign.id) ?? 0) : null,
                };
            }),
        })),
    });
});

router.post('/advertisers', async (request, response) => {
    const input = parse(advertiserSchema, request.body);
    const advertiser = await prisma.advertiser.create({ data: input });
    response.status(201).json({ advertiser });
});

router.patch('/advertisers/:id', async (request, response) => {
    const id = uuidParam(request.params.id, 'Advertiser not found');
    const input = parse(advertiserSchema.partial(), request.body);
    const exists = await prisma.advertiser.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw notFound('Advertiser not found');
    const advertiser = await prisma.advertiser.update({ where: { id }, data: input });
    clearAdCache();
    response.json({ advertiser });
});

router.post('/campaigns', async (request, response) => {
    const { advertiser_id, ...input } = parse(createCampaignSchema, request.body);
    if (!(await prisma.advertiser.findUnique({ where: { id: advertiser_id }, select: { id: true } }))) throw notFound('Advertiser not found');
    checkDates(input.starts_at, input.ends_at);
    const campaign = await prisma.campaign.create({
        data: {
            ...(await campaignData({ ...input, targeting: input.targeting ?? { communities: [], categories: [] } })),
            name: input.name,
            advertiser_id,
            stats_token: randomBytes(18).toString('base64url'),
        },
    });
    clearAdCache();
    response.status(201).json({ campaign: campaignOut(campaign) });
});

async function findCampaign(rawId: unknown) {
    const campaign = await prisma.campaign.findUnique({ where: { id: uuidParam(rawId, 'Campaign not found') } });
    if (!campaign) throw notFound('Campaign not found');
    return campaign;
}

// One campaign with its creatives, their totals and the last 30 days
router.get('/campaigns/:id', async (request, response) => {
    const campaign = await findCampaign(request.params.id);
    const [advertiser, creatives] = await Promise.all([
        prisma.advertiser.findUniqueOrThrow({ where: { id: campaign.advertiser_id } }),
        prisma.adCreative.findMany({ where: { campaign_id: campaign.id }, orderBy: { created_at: 'asc' } }),
    ]);
    const ids = creatives.map((creative) => creative.id);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [totals, days, spend] = await Promise.all([
        statsTotals(ids),
        ids.length
            ? prisma.adDailyStat.groupBy({
                  by: ['date'],
                  where: { creative_id: { in: ids }, date: { gte: since } },
                  _sum: { impressions: true, clicks: true },
                  orderBy: { date: 'desc' },
              })
            : [],
        campaign.pricing_model === 'cpm' ? campaignSpend([campaign.id]) : new Map<string, number>(),
    ]);
    response.json({
        campaign: { ...campaignOut(campaign), spent_minor: campaign.pricing_model === 'cpm' ? (spend.get(campaign.id) ?? 0) : null },
        advertiser,
        creatives: creatives.map((creative) => ({ ...creative, ...(totals.get(creative.id) ?? { impressions: 0, clicks: 0 }) })),
        days: days.map((day) => ({
            date: day.date.toISOString().slice(0, 10),
            impressions: day._sum.impressions ?? 0,
            clicks: day._sum.clicks ?? 0,
        })),
    });
});

router.patch('/campaigns/:id', async (request, response) => {
    const campaign = await findCampaign(request.params.id);
    const input = parse(updateCampaignSchema, request.body);
    checkDates(input.starts_at === undefined ? campaign.starts_at : input.starts_at, input.ends_at === undefined ? campaign.ends_at : input.ends_at);
    const updated = await prisma.campaign.update({ where: { id: campaign.id }, data: await campaignData(input) });
    clearAdCache();
    response.json({ campaign: campaignOut(updated) });
});

router.post('/campaigns/:id/creatives', async (request, response) => {
    const campaign = await findCampaign(request.params.id);
    const input = parse(createCreativeSchema, request.body);
    const creative = await prisma.adCreative.create({ data: { ...input, campaign_id: campaign.id } });
    clearAdCache();
    response.status(201).json({ creative });
});

// Pausing a creative also settles open reports about it
router.patch('/creatives/:id', async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const id = uuidParam(request.params.id, 'Ad not found');
    const input = parse(updateCreativeSchema, request.body);
    if (!(await prisma.adCreative.findUnique({ where: { id }, select: { id: true } }))) throw notFound('Ad not found');
    const creative = await prisma.adCreative.update({ where: { id }, data: input });
    if (input.is_active === false) await closeReports('ad', id, 'resolved', user.id);
    clearAdCache();
    response.json({ creative });
});

export default router;
