import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../prismaConnection';
import { afterCursor, decodeCursor, paginate } from '../../lib/cursor';
import { badRequest, conflict, notFound, parse, uuidParam } from '../../lib/http';
import { AuthRequest, requireAuth, viewerOf } from '../../middlewares/auth';
import { LIMITS, pageQuery } from '../../shared/validation';
import { revokeAllSessions } from '../auth/service';
import { viewerContext } from '../communities/access';
import { buildQueue, queueCount } from '../moderation/queue';
import { requireAdmin } from '../moderation/routes';
import { clearBlocklistCache } from '../safety/filters';
import adsAdmin from '../ads/admin';
import { clearAdCache } from '../ads/decision';

// Site-admin panel (role=admin): the site-wide queue, user suspension and shadow-bans, community takedowns,
// the blocklist and ad campaigns (ads/admin.ts). Every action is written to ModAction like moderator actions are.

const router = Router();

router.use(requireAuth, (request, response, next) => {
    requireAdmin(viewerOf(request).user);
    next();
});

const reason = z.string().trim().max(LIMITS.REASON_MAX).optional();

const log = (actorId: string, action: string, target: { type: 'user' | 'community'; id: string }, extra: { reason?: string; details?: Prisma.InputJsonValue; communityId?: string } = {}) =>
    prisma.modAction.create({
        data: {
            actor_id: actorId,
            community_id: extra.communityId ?? null,
            action,
            target_type: target.type,
            target_id: target.id,
            reason: extra.reason ?? null,
            details: extra.details,
        },
    });

// Every open report and every held item, across all communities
router.get('/queue', async (request: AuthRequest, response) => {
    const items = await buildQueue({ site: true }, await viewerContext(request.viewer));
    response.json({ items });
});

router.get('/overview', async (request, response) => {
    const day = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [queue, users, newUsers, posts, comments, suspended, shadowBanned] = await Promise.all([
        queueCount({ site: true }),
        prisma.user.count({ where: { status: { not: 'deleted' } } }),
        prisma.user.count({ where: { created_at: { gte: day } } }),
        prisma.post.count({ where: { created_at: { gte: day } } }),
        prisma.comment.count({ where: { created_at: { gte: day } } }),
        prisma.user.count({ where: { status: 'suspended' } }),
        prisma.user.count({ where: { shadow_banned_at: { not: null } } }),
    ]);
    response.json({ queue, users, new_users_24h: newUsers, posts_24h: posts, comments_24h: comments, suspended, shadow_banned: shadowBanned });
});

// --- Users ---

const userSelect = {
    id: true,
    username: true,
    email: true,
    role: true,
    status: true,
    karma: true,
    created_at: true,
    last_login_at: true,
    email_verified_at: true,
    suspended_until: true,
    suspension_reason: true,
    shadow_banned_at: true,
    _count: { select: { posts: true, comments: true, reports_sent: true } },
} satisfies Prisma.UserSelect;

const usersQuery = z.object({
    q: z.string().trim().max(254).optional(),
    filter: z.enum(['all', 'suspended', 'shadow_banned', 'new']).default('all'),
});

router.get('/users', async (request, response) => {
    const { q, filter } = parse(usersQuery, request.query);
    const value = q?.toLowerCase();
    const where: Prisma.UserWhereInput = {
        status: { not: 'deleted' },
        ...(value ? { OR: [{ username: { startsWith: value } }, { email: { startsWith: value } }] } : {}),
        ...(filter === 'suspended' ? { status: 'suspended' } : {}),
        ...(filter === 'shadow_banned' ? { shadow_banned_at: { not: null } } : {}),
        ...(filter === 'new' ? { created_at: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } : {}),
    };
    const users = await prisma.user.findMany({ where, orderBy: { created_at: 'desc' }, take: 50, select: userSelect });
    response.json({ users });
});

async function findUser(username: string) {
    const user = await prisma.user.findUnique({ where: { username: username.toLowerCase() } });
    if (!user || user.status === 'deleted') throw notFound('User not found');
    return user;
}

const suspendSchema = z.object({ days: z.number().int().min(1).max(3650).optional(), reason });

// Signs the account out everywhere; the suspension lifts itself at the next sign-in after it ends
router.post('/users/:username/suspend', async (request: AuthRequest, response) => {
    const { user: actor } = viewerOf(request);
    const input = parse(suspendSchema, request.body);
    const user = await findUser(String(request.params.username));
    if (user.id === actor.id) throw badRequest("You can't suspend yourself.", 'self_suspend');
    if (user.role === 'admin') throw badRequest('Admins must be demoted before they can be suspended.', 'target_is_admin');

    const until = input.days ? new Date(Date.now() + input.days * 24 * 60 * 60 * 1000) : null;
    const updated = await prisma.user.update({
        where: { id: user.id },
        data: { status: 'suspended', suspended_until: until, suspension_reason: input.reason ?? null },
        select: userSelect,
    });
    await revokeAllSessions(user.id);
    await log(actor.id, 'suspend_user', { type: 'user', id: user.id }, { reason: input.reason, details: { until: until?.toISOString() ?? null } });
    response.json({ user: updated });
});

router.post('/users/:username/unsuspend', async (request: AuthRequest, response) => {
    const { user: actor } = viewerOf(request);
    const user = await findUser(String(request.params.username));
    if (user.status !== 'suspended') throw badRequest('This account is not suspended.', 'not_suspended');
    const updated = await prisma.user.update({
        where: { id: user.id },
        data: { status: 'active', suspended_until: null, suspension_reason: null },
        select: userSelect,
    });
    await log(actor.id, 'unsuspend_user', { type: 'user', id: user.id });
    response.json({ user: updated });
});

const shadowBanSchema = z.object({ shadow_banned: z.boolean(), reason });

// Hides (or shows again) everything the account has written and will write, then fixes up the counters
router.post('/users/:username/shadow-ban', async (request: AuthRequest, response) => {
    const { user: actor } = viewerOf(request);
    const input = parse(shadowBanSchema, request.body);
    const user = await findUser(String(request.params.username));
    if (user.role === 'admin') throw badRequest("Admins can't be shadow-banned.", 'target_is_admin');

    await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { shadow_banned_at: input.shadow_banned ? new Date() : null } });
        await tx.post.updateMany({ where: { author_id: user.id }, data: { shadow_hidden: input.shadow_banned } });
        await tx.comment.updateMany({ where: { author_id: user.id }, data: { shadow_hidden: input.shadow_banned } });
        await recountAfterVisibilityChange(tx, user.id);
    });
    await log(actor.id, input.shadow_banned ? 'shadow_ban_user' : 'lift_shadow_ban', { type: 'user', id: user.id }, { reason: input.reason });
    response.json({ user: await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: userSelect }) });
});

// Recomputes the counters an author's content feeds: comment counts of the posts they commented on, reply counts
// of the comments they replied to, and post counts of the communities they posted in
async function recountAfterVisibilityChange(tx: Prisma.TransactionClient, userId: string) {
    await tx.$executeRaw`
        UPDATE "Post" p SET "comment_count" = (
            SELECT count(*) FROM "Comment" c
            WHERE c."post_id" = p."id" AND c."status" IN ('active', 'locked') AND NOT c."shadow_hidden")
        WHERE p."id" IN (SELECT "post_id" FROM "Comment" WHERE "author_id" = ${userId}::uuid)`;
    await tx.$executeRaw`
        UPDATE "Comment" pc SET "reply_count" = (
            SELECT count(*) FROM "Comment" c
            WHERE c."parent_id" = pc."id" AND c."status" <> 'pending' AND NOT c."shadow_hidden")
        WHERE pc."id" IN (SELECT "parent_id" FROM "Comment" WHERE "author_id" = ${userId}::uuid AND "parent_id" IS NOT NULL)`;
    await tx.$executeRaw`
        UPDATE "Community" cm SET "post_count" = (
            SELECT count(*) FROM "Post" p
            WHERE p."community_id" = cm."id" AND p."status" IN ('active', 'locked') AND NOT p."shadow_hidden")
        WHERE cm."id" IN (SELECT "community_id" FROM "Post" WHERE "author_id" = ${userId}::uuid)`;
}

// --- Communities ---

router.get('/communities', async (request, response) => {
    const { q } = parse(z.object({ q: z.string().trim().max(50).optional() }), request.query);
    const communities = await prisma.community.findMany({
        where: q ? { name: { startsWith: q.toLowerCase() } } : {},
        orderBy: { created_at: 'desc' },
        take: 50,
        select: {
            id: true,
            name: true,
            display_name: true,
            status: true,
            visibility: true,
            category: true,
            is_nsfw: true,
            ads_enabled: true,
            member_count: true,
            post_count: true,
            created_at: true,
        },
    });
    response.json({ communities });
});

// A takedown hides the community and everything in it (its pages answer 410 to crawlers); restore undoes it
router.post('/communities/:name/takedown', async (request: AuthRequest, response) => {
    const { user: actor } = viewerOf(request);
    const { reason: why } = parse(z.object({ reason }), request.body);
    const community = await prisma.community.findUnique({ where: { name: String(request.params.name).toLowerCase() } });
    if (!community) throw notFound('Community not found');
    if (community.status === 'deleted') throw conflict('This community is already taken down.', 'already_taken_down');
    await prisma.community.update({ where: { id: community.id }, data: { status: 'deleted' } });
    await log(actor.id, 'takedown_community', { type: 'community', id: community.id }, { reason: why, communityId: community.id, details: { previous: community.status } });
    response.json({ success: true });
});

router.post('/communities/:name/restore', async (request: AuthRequest, response) => {
    const { user: actor } = viewerOf(request);
    const community = await prisma.community.findUnique({ where: { name: String(request.params.name).toLowerCase() } });
    if (!community) throw notFound('Community not found');
    if (community.status !== 'deleted') throw badRequest('This community is not taken down.', 'not_taken_down');
    await prisma.community.update({ where: { id: community.id }, data: { status: 'active' } });
    await log(actor.id, 'restore_community', { type: 'community', id: community.id }, { communityId: community.id });
    response.json({ success: true });
});

// Ads on or off for one community; null goes back to the default (off in sensitive categories)
router.patch('/communities/:name/ads', async (request: AuthRequest, response) => {
    const { user: actor } = viewerOf(request);
    const { ads_enabled } = parse(z.object({ ads_enabled: z.boolean().nullable() }), request.body);
    const community = await prisma.community.findUnique({ where: { name: String(request.params.name).toLowerCase() } });
    if (!community) throw notFound('Community not found');
    await prisma.community.update({ where: { id: community.id }, data: { ads_enabled } });
    clearAdCache();
    await log(actor.id, 'set_community_ads', { type: 'community', id: community.id }, { communityId: community.id, details: { ads_enabled } });
    response.json({ success: true, ads_enabled });
});

// --- Ads ---

router.use('/ads', adsAdmin);

// --- Blocklist ---

const DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/;

const termSchema = z
    .object({
        kind: z.enum(['domain', 'keyword']),
        value: z.string().trim().toLowerCase().min(2).max(100),
        note: z.string().trim().max(200).optional(),
    })
    .transform((term) =>
        term.kind === 'domain' ? { ...term, value: term.value.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') } : term
    )
    .refine((term) => term.kind !== 'domain' || DOMAIN.test(term.value), { message: 'Enter a domain like example.com', path: ['value'] });

router.get('/blocklist', async (request, response) => {
    const terms = await prisma.blockedTerm.findMany({
        orderBy: [{ kind: 'asc' }, { value: 'asc' }],
        select: { id: true, kind: true, value: true, note: true, created_at: true, creator: { select: { username: true } } },
    });
    response.json({ terms });
});

router.post('/blocklist', async (request: AuthRequest, response) => {
    const { user: actor } = viewerOf(request);
    const input = parse(termSchema, request.body);
    try {
        const term = await prisma.blockedTerm.create({
            data: { ...input, note: input.note ?? null, created_by: actor.id },
            select: { id: true, kind: true, value: true, note: true, created_at: true },
        });
        clearBlocklistCache();
        response.status(201).json({ term });
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw conflict('That is already on the blocklist.', 'already_blocked');
        }
        throw error;
    }
});

router.delete('/blocklist/:id', async (request, response) => {
    const result = await prisma.blockedTerm.deleteMany({ where: { id: uuidParam(request.params.id, 'Entry not found') } });
    if (result.count === 0) throw notFound('Entry not found');
    clearBlocklistCache();
    response.json({ success: true });
});

// --- Log ---

// Every moderator and admin action on the site, newest first
router.get('/mod-log', async (request, response) => {
    const query = parse(pageQuery, request.query);
    const rows = await prisma.modAction.findMany({
        where: afterCursor('created_at', 'desc', decodeCursor(query.cursor)),
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        select: {
            id: true,
            created_at: true,
            action: true,
            target_type: true,
            target_id: true,
            reason: true,
            details: true,
            actor: { select: { username: true } },
            community: { select: { name: true } },
        },
    });
    const { items, next_cursor } = paginate(rows, query.limit, 'created_at');
    response.json({ actions: items, next_cursor });
});

export default router;
