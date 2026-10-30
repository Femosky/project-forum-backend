import express, { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../prismaConnection';
import { idOrShortId } from '../../lib/ids';
import { badRequest, notFound, parse, uuidParam } from '../../lib/http';
import { decideAds, MAX_ADS_PER_REQUEST, parseSeen } from './decision';
import { resolveDestination } from './urls';

// Public ad endpoints: the decision service, viewable-impression events, click-through and the advertiser's
// read-only stats page. Admin management is in admin.ts.

const router = Router();

const adsQuery = z.object({
    placement: z.enum(['feed', 'thread']),
    community: z.string().trim().toLowerCase().max(21).optional(),
    // Thread placements name the post, so locked, removed and NSFW threads get no ads
    post: z.string().trim().max(36).optional(),
    count: z.coerce.number().int().min(1).max(MAX_ADS_PER_REQUEST).default(1),
    seen: z.string().max(2000).optional(),
});

const communitySelect = { name: true, category: true, status: true, visibility: true, is_nsfw: true, ads_enabled: true } as const;

router.get('/', async (request, response) => {
    const query = parse(adsQuery, request.query);
    // Ads depend on the viewer's frequency counts, so nothing between here and the browser should cache them
    response.setHeader('Cache-Control', 'private, no-store');

    let community = null;
    if (query.placement === 'thread') {
        if (!query.post) throw badRequest('Thread ads need a post.', 'post_required');
        const post = await prisma.post.findFirst({
            where: idOrShortId(query.post),
            select: { status: true, is_nsfw: true, shadow_hidden: true, community: { select: communitySelect } },
        });
        if (!post || post.status !== 'active' || post.is_nsfw || post.shadow_hidden) {
            response.json({ ads: [] });
            return;
        }
        community = post.community;
    } else if (query.community) {
        community = await prisma.community.findUnique({ where: { name: query.community }, select: communitySelect });
        if (!community) {
            response.json({ ads: [] });
            return;
        }
    }

    const ads = await decideAds({ placement: query.placement, community, count: query.count, seen: parseSeen(query.seen) });
    response.json({ ads });
});

// Viewable impressions, sent in batches by the browser. Plain-text bodies are accepted too: that keeps the
// request "simple" for CORS, so it needs no preflight and survives the page closing (fetch keepalive).
const eventsSchema = z.object({ impressions: z.array(z.uuid()).min(1).max(50) });

router.post('/events', express.text({ type: 'text/plain', limit: '10kb' }), async (request, response) => {
    let body: unknown = request.body;
    if (typeof body === 'string') {
        try {
            body = JSON.parse(body);
        } catch {
            throw badRequest('Send JSON.', 'invalid_json');
        }
    }
    const { impressions } = parse(eventsSchema, body);

    // One creative can be seen a few times on one page (two feed slots); more than that in one batch is noise
    const counts = new Map<string, number>();
    for (const id of impressions) counts.set(id.toLowerCase(), Math.min((counts.get(id.toLowerCase()) ?? 0) + 1, 5));
    await recordStats([...counts].map(([id, n]) => ({ id, impressions: n, clicks: 0 })));
    response.status(202).json({ success: true });
});

// Counts the click and sends the reader on to the advertiser
router.get('/click/:id', async (request, response) => {
    const id = uuidParam(request.params.id, 'Ad not found');
    const creative = await prisma.adCreative.findUnique({ where: { id }, select: { click_url: true } });
    if (!creative) throw notFound('Ad not found');
    await recordStats([{ id, impressions: 0, clicks: 1 }]);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    // Links to this site (and leftovers pointing at a local test server) land on the same page of WEB_URL
    response.redirect(302, resolveDestination(creative.click_url));
});

// Adds to today's AdDailyStat rows (days run on Lagos time). Unknown creative ids are skipped.
async function recordStats(rows: { id: string; impressions: number; clicks: number }[]) {
    if (rows.length === 0) return;
    const values = Prisma.join(rows.map((row) => Prisma.sql`(${row.id}::uuid, ${row.impressions}::int, ${row.clicks}::int)`));
    await prisma.$executeRaw`
        INSERT INTO "AdDailyStat" ("creative_id", "date", "impressions", "clicks")
        SELECT v.id, (now() AT TIME ZONE 'Africa/Lagos')::date, v.impressions, v.clicks
        FROM (VALUES ${values}) AS v(id, impressions, clicks)
        WHERE EXISTS (SELECT 1 FROM "AdCreative" a WHERE a."id" = v.id)
        ON CONFLICT ("creative_id", "date") DO UPDATE SET
            "impressions" = "AdDailyStat"."impressions" + EXCLUDED."impressions",
            "clicks" = "AdDailyStat"."clicks" + EXCLUDED."clicks"`;
}

// The advertiser's read-only stats page, behind an unguessable token
router.get('/stats/:token', async (request, response) => {
    const token = String(request.params.token);
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw notFound('Campaign not found');
    const campaign = await prisma.campaign.findUnique({
        where: { stats_token: token },
        include: {
            advertiser: { select: { name: true } },
            creatives: { select: { id: true, headline: true, format: true, is_active: true, daily_stats: true }, orderBy: { created_at: 'asc' } },
        },
    });
    if (!campaign) throw notFound('Campaign not found');

    const days = new Map<string, { impressions: number; clicks: number }>();
    const creatives = campaign.creatives.map((creative) => {
        let impressions = 0;
        let clicks = 0;
        for (const stat of creative.daily_stats) {
            impressions += stat.impressions;
            clicks += stat.clicks;
            const key = stat.date.toISOString().slice(0, 10);
            const day = days.get(key) ?? { impressions: 0, clicks: 0 };
            day.impressions += stat.impressions;
            day.clicks += stat.clicks;
            days.set(key, day);
        }
        return { headline: creative.headline, format: creative.format, is_active: creative.is_active, impressions, clicks };
    });

    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    response.json({
        campaign: {
            name: campaign.name,
            advertiser: campaign.advertiser.name,
            status: campaign.status,
            starts_at: campaign.starts_at,
            ends_at: campaign.ends_at,
            pricing_model: campaign.pricing_model,
            currency: campaign.currency,
        },
        totals: {
            impressions: creatives.reduce((sum, creative) => sum + creative.impressions, 0),
            clicks: creatives.reduce((sum, creative) => sum + creative.clicks, 0),
        },
        days: [...days].sort(([a], [b]) => b.localeCompare(a)).map(([date, day]) => ({ date, ...day })),
        creatives,
    });
});

export default router;
