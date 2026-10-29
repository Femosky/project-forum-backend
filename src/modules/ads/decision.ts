import { AdFormat, CampaignKind, Community, Prisma } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env';
import prisma from '../../prismaConnection';
import { onSitePath } from './urls';

// The ad decision service: which ads fill the slots on a page. Priority order is direct campaigns that target
// this community or its category, then direct campaigns that run everywhere, then house ads (same order), then
// AdSense for whatever is left. House campaigns with a share (house_share, up to 50%) also win that share of
// slots outright, so the site's own products are seen even when paid campaigns fill everything. Pages only ever
// see AdUnit[]; they don't know where an ad came from.

export type AdPlacement = 'feed' | 'thread';

export const FORMAT_FOR: Record<AdPlacement, AdFormat> = { feed: 'feed_post', thread: 'thread_comment' };

// Communities in these categories carry no ads unless an admin switches them on (mental health, grief)
export const SENSITIVE_CATEGORIES = new Set(['health']);

// Most slots one request can ask for
export const MAX_ADS_PER_REQUEST = 6;

export const targetingSchema = z.object({
    communities: z.array(z.string().trim().toLowerCase().min(1).max(21)).max(100).default([]),
    categories: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
});
export type Targeting = z.infer<typeof targetingSchema>;

export function readTargeting(value: Prisma.JsonValue | null): Targeting {
    const parsed = targetingSchema.safeParse(value ?? {});
    return parsed.success ? parsed.data : { communities: [], categories: [] };
}

type NativeCreative = {
    advertiser_name: string;
    advertiser_logo: string | null;
    title: string;
    body: string | null;
    image_url: string | null;
    cta_label: string;
    // Host shown on the card, or null when the ad leads to a page on this site (the card then shows the site's
    // name). The click itself goes through /v1/ads/click/:id either way.
    display_url: string | null;
};

export type AdUnit =
    | { kind: 'direct' | 'house'; id: string; campaign_id: string; frequency_cap: number | null; creative: NativeCreative }
    | { kind: 'adsense'; id: string; client: string; slot_id: string; format: 'in-feed' | 'in-article'; layout_key: string | null };

type LiveCreative = {
    id: string;
    campaign_id: string;
    kind: CampaignKind;
    format: AdFormat;
    priority: number;
    house_share: number;
    frequency_cap: number | null;
    targeting: Targeting;
    creative: NativeCreative;
};

// All house shares together never take more than this percent of slots
export const MAX_HOUSE_SHARE = 50;

function hostOf(url: string): string | null {
    if (onSitePath(url) !== null) return null;
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return null;
    }
}

// Every creative that can run right now. Campaigns change rarely and every page view asks, so the list is kept
// in memory for a short while; admin changes clear it straight away.
const CACHE_MS = env.IS_TEST ? 0 : 30_000;
let cache: { at: number; creatives: Promise<LiveCreative[]> } | null = null;

export function clearAdCache() {
    cache = null;
}

async function loadLiveCreatives(): Promise<LiveCreative[]> {
    const now = new Date();
    const campaigns = await prisma.campaign.findMany({
        where: {
            status: 'active',
            OR: [{ starts_at: null }, { starts_at: { lte: now } }],
            AND: [{ OR: [{ ends_at: null }, { ends_at: { gt: now } }] }],
            creatives: { some: { is_active: true } },
        },
        include: { advertiser: true, creatives: { where: { is_active: true } } },
    });
    const spent = await campaignSpend(campaigns.filter((campaign) => campaign.pricing_model === 'cpm').map((campaign) => campaign.id));

    return campaigns
        .filter((campaign) => {
            // A CPM campaign stops once its budget is used up
            if (campaign.pricing_model !== 'cpm' || campaign.budget_minor === null) return true;
            return (spent.get(campaign.id) ?? 0) < campaign.budget_minor;
        })
        .flatMap((campaign) =>
            campaign.creatives.map((creative) => ({
                id: creative.id,
                campaign_id: campaign.id,
                kind: campaign.kind,
                format: creative.format,
                priority: campaign.priority,
                house_share: campaign.kind === 'house' ? Math.min(Math.max(campaign.house_share, 0), MAX_HOUSE_SHARE) : 0,
                frequency_cap: campaign.frequency_cap,
                targeting: readTargeting(campaign.targeting),
                creative: {
                    advertiser_name: campaign.advertiser.name,
                    advertiser_logo: campaign.advertiser.logo_url,
                    title: creative.headline,
                    body: creative.body,
                    image_url: creative.image_url,
                    cta_label: creative.cta_label,
                    display_url: hostOf(creative.click_url),
                },
            }))
        );
}

function liveCreatives() {
    if (!cache || Date.now() - cache.at > CACHE_MS) {
        const creatives = loadLiveCreatives();
        cache = { at: Date.now(), creatives };
        // A failed load shouldn't stick around for the next request
        creatives.catch(() => (cache = null));
    }
    return cache.creatives;
}

// Impressions a CPM campaign has paid for so far, in minor units: impressions x CPM / 1000
export async function campaignSpend(campaignIds: string[]): Promise<Map<string, number>> {
    if (campaignIds.length === 0) return new Map();
    const rows = await prisma.$queryRaw<{ campaign_id: string; spent: number }[]>`
        SELECT c."id"::text AS campaign_id, floor(coalesce(sum(s."impressions"), 0) * coalesce(c."price_minor", 0) / 1000)::int AS spent
        FROM "Campaign" c
        JOIN "AdCreative" a ON a."campaign_id" = c."id"
        LEFT JOIN "AdDailyStat" s ON s."creative_id" = a."id"
        WHERE c."id" IN (${Prisma.join(campaignIds.map((id) => Prisma.sql`${id}::uuid`))})
        GROUP BY c."id"`;
    return new Map(rows.map((row) => [row.campaign_id, row.spent]));
}

type AdCommunity = Pick<Community, 'name' | 'category' | 'status' | 'visibility' | 'is_nsfw' | 'ads_enabled'>;

// Brand safety for a community: no ads on NSFW, private or taken-down communities, or in sensitive categories
// unless an admin switched them on
export function communityAllowsAds(community: AdCommunity) {
    if (community.status !== 'active' || community.visibility !== 'public' || community.is_nsfw) return false;
    return community.ads_enabled ?? !SENSITIVE_CATEGORIES.has(community.category ?? '');
}

function matches(targeting: Targeting, community: AdCommunity | null) {
    const runsEverywhere = targeting.communities.length === 0 && targeting.categories.length === 0;
    if (runsEverywhere) return true;
    if (!community) return false;
    return targeting.communities.includes(community.name) || (community.category !== null && targeting.categories.includes(community.category));
}

// Lower ranks first: targeted direct, run-of-site direct, targeted house, run-of-site house
function rankOf(creative: LiveCreative) {
    const targeted = creative.targeting.communities.length > 0 || creative.targeting.categories.length > 0;
    return (creative.kind === 'direct' ? 0 : 2) + (targeted ? 0 : 1);
}

function adsenseUnits(placement: AdPlacement, count: number): AdUnit[] {
    const slot = placement === 'feed' ? env.ADSENSE_FEED_SLOT : env.ADSENSE_THREAD_SLOT;
    if (!env.ADSENSE_ENABLED || !env.ADSENSE_CLIENT_ID || !slot) return [];
    return Array.from({ length: count }, (_, index) => ({
        kind: 'adsense' as const,
        id: `adsense-${placement}-${index}`,
        client: env.ADSENSE_CLIENT_ID!,
        slot_id: slot,
        format: placement === 'feed' ? ('in-feed' as const) : ('in-article' as const),
        layout_key: placement === 'feed' ? (env.ADSENSE_FEED_LAYOUT_KEY ?? null) : null,
    }));
}

export type DecisionInput = {
    placement: AdPlacement;
    community: AdCommunity | null;
    count: number;
    // Campaign id -> times this viewer saw it today (from the web app's frequency cookie)
    seen: Map<string, number>;
    // Tests pass their own dice
    random?: () => number;
};

export async function decideAds({ placement, community, count, seen, random = Math.random }: DecisionInput): Promise<AdUnit[]> {
    if (!env.ADS_ENABLED || count <= 0) return [];
    if (community && !communityAllowsAds(community)) return [];

    const candidates = (await liveCreatives())
        .filter((creative) => creative.format === FORMAT_FOR[placement])
        .filter((creative) => matches(creative.targeting, community))
        .filter((creative) => creative.frequency_cap === null || (seen.get(creative.campaign_id) ?? 0) < creative.frequency_cap)
        // Shuffle first so campaigns with the same rank and priority take turns
        .map((creative) => ({ creative, tiebreak: random() }))
        .sort((a, b) => rankOf(a.creative) - rankOf(b.creative) || b.creative.priority - a.creative.priority || a.tiebreak - b.tiebreak)
        .map(({ creative }) => creative);

    // House campaigns with a share roll for each slot first; the rest goes in rank order. One creative shows
    // once per page.
    const shared = candidates.filter((creative) => creative.house_share > 0);
    const totalShare = shared.reduce((sum, creative) => sum + creative.house_share, 0);
    const scale = totalShare > MAX_HOUSE_SHARE ? MAX_HOUSE_SHARE / totalShare : 1;
    const used = new Set<string>();
    const picked: LiveCreative[] = [];
    for (let slot = 0; slot < count; slot++) {
        const roll = random() * 100;
        let edge = 0;
        let pick = shared.find((creative) => {
            if (used.has(creative.id)) return false;
            edge += creative.house_share * scale;
            return roll < edge;
        });
        pick ??= candidates.find((creative) => !used.has(creative.id));
        if (!pick) break;
        used.add(pick.id);
        picked.push(pick);
    }

    const native: AdUnit[] = picked.map((creative) => ({
        kind: creative.kind,
        id: creative.id,
        campaign_id: creative.campaign_id,
        frequency_cap: creative.frequency_cap,
        creative: creative.creative,
    }));
    return [...native, ...adsenseUnits(placement, count - native.length)];
}

// "id:count,id:count" -> Map. Anything malformed is ignored.
export function parseSeen(value: string | undefined): Map<string, number> {
    const seen = new Map<string, number>();
    for (const part of (value ?? '').split(',').slice(0, 50)) {
        const [id, times] = part.split(':');
        const n = Number(times);
        if (id && /^[0-9a-f-]{36}$/i.test(id) && Number.isInteger(n) && n > 0) seen.set(id.toLowerCase(), n);
    }
    return seen;
}
