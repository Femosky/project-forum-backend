import { avatarCode } from '../../lib/avatars';
import { Router } from 'express';
import { Community, CommunityMember, Prisma } from '@prisma/client';
import prisma from '../../prismaConnection';
import { afterCursor, decodeCursor, paginate } from '../../lib/cursor';
import { badRequest, conflict, forbidden, HttpError, notFound, parse, uuidParam } from '../../lib/http';
import { LISTED_POST_STATUSES, notShadowHidden, postInclude } from '../../lib/serializers';
import { AuthRequest, optionalAuth, requireAuth, viewerOf } from '../../middlewares/auth';
import { COMMUNITY_CATEGORIES } from '../../shared/validation';
import { listPosts, serializePosts } from '../posts/service';
import { queueCount } from '../moderation/queue';
import {
    activeMute,
    assertCanView,
    assertModerator,
    assertOwner,
    findCommunity,
    findMembership,
    isActiveMember,
    isBanned,
    viewerContext,
} from './access';
import {
    banSchema,
    communityPostsQuery,
    createCommunitySchema,
    flairSchema,
    joinDecisionSchema,
    joinSchema,
    listCommunitiesQuery,
    RESERVED_NAMES,
    roleSchema,
    updateCommunitySchema,
} from './schema';

const router = Router();

export function toPublicCommunity(community: Community) {
    return {
        id: community.id,
        // The URL key (lowercase) and the handle as shown ("PremierLeague")
        name: community.name,
        name_styled: community.name_styled ?? community.name,
        display_name: community.display_name,
        description: community.description,
        image_url: community.image_url,
        banner_url: community.banner_url,
        rules: community.rules,
        category: community.category,
        visibility: community.visibility,
        status: community.status,
        is_nsfw: community.is_nsfw,
        member_count: community.member_count,
        post_count: community.post_count,
        created_at: community.created_at,
    };
}

function viewerMembership(member: CommunityMember | null, hasPendingRequest: boolean, mutedUntil: Date | null, queue: number | null) {
    return {
        is_member: isActiveMember(member),
        role: isActiveMember(member) ? member.role : null,
        is_banned: isBanned(member),
        has_pending_request: hasPendingRequest,
        muted_until: mutedUntil,
        // Moderators only: items waiting in the mod queue
        queue_count: queue,
    };
}

router.get('/', async (request, response) => {
    const query = parse(listCommunitiesQuery, request.query);
    const field = query.sort === 'popular' ? 'member_count' : 'created_at';
    const search = query.q
        ? {
              OR: [
                  { name: { contains: query.q, mode: 'insensitive' as const } },
                  { display_name: { contains: query.q, mode: 'insensitive' as const } },
                  { description: { contains: query.q, mode: 'insensitive' as const } },
              ],
          }
        : {};
    const rows = await prisma.community.findMany({
        where: {
            AND: [
                { status: 'active', ...(query.category ? { category: query.category } : {}), ...search },
                afterCursor(field, 'desc', decodeCursor(query.cursor)),
            ],
        },
        orderBy: [{ [field]: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
    });
    const { items, next_cursor } = paginate(rows, query.limit, field);
    response.json({ communities: items.map(toPublicCommunity), next_cursor });
});

// Directory categories with how many communities each has
router.get('/categories', async (request, response) => {
    const counts = await prisma.community.groupBy({ by: ['category'], where: { status: 'active' }, _count: { _all: true } });
    const countOf = new Map(counts.map((row) => [row.category, row._count._all]));
    response.json({
        categories: Object.entries(COMMUNITY_CATEGORIES).map(([id, label]) => ({ id, label, count: countOf.get(id) ?? 0 })),
    });
});

router.post('/', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const input = parse(createCommunitySchema, request.body);
    if (RESERVED_NAMES.has(input.name.toLowerCase())) throw badRequest('That name is reserved.', 'name_reserved');
    // An old name still points at the community that had it
    if (await prisma.communityAlias.findUnique({ where: { name: input.name } })) {
        throw conflict('A community with that name already exists.', 'name_taken');
    }

    try {
        const community = await prisma.$transaction(async (tx) => {
            const created = await tx.community.create({
                data: {
                    name: input.name.toLowerCase(),
                    name_styled: input.name,
                    display_name: input.display_name ?? null,
                    description: input.description ?? null,
                    visibility: input.visibility,
                    is_nsfw: input.is_nsfw,
                    rules: input.rules ?? Prisma.JsonNull,
                    category: input.category ?? null,
                    created_by: user.id,
                    member_count: 1,
                },
            });
            await tx.communityMember.create({ data: { community_id: created.id, user_id: user.id, role: 'owner' } });
            return created;
        });
        response.status(201).json({ community: toPublicCommunity(community) });
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw conflict('A community with that name already exists.', 'name_taken');
        }
        throw error;
    }
});

router.get('/:name', optionalAuth, async (request: AuthRequest, response) => {
    const community = await findCommunity(String(request.params.name));
    const userId = request.viewer?.user.id;
    const [member, pending, moderators, mute] = await Promise.all([
        findMembership(community.id, userId),
        userId
            ? prisma.communityJoinRequest.findFirst({ where: { community_id: community.id, user_id: userId, status: 'pending' } })
            : null,
        prisma.communityMember.findMany({
            where: { community_id: community.id, role: { in: ['owner', 'moderator'] }, is_banned: false },
            orderBy: { joined_at: 'asc' },
            select: { role: true, user: { select: { username: true, display_name: true, avatar_id: true, avatar_config: true } } },
        }),
        userId ? activeMute(community.id, userId) : null,
    ]);
    const moderates = request.viewer?.user.role === 'admin' || (isActiveMember(member) && member.role !== 'member');
    const queue = moderates ? await queueCount({ communityId: community.id }) : null;
    response.json({
        community: toPublicCommunity(community),
        moderators: moderators.map(({ user: { avatar_config, ...user }, role }) => ({ ...user, avatar: avatarCode(avatar_config), role })),
        viewer: request.viewer ? viewerMembership(member, Boolean(pending), mute?.muted_until ?? null, queue) : null,
    });
});

router.patch('/:name', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    await assertModerator(community.id, user);
    const input = parse(updateCommunitySchema, request.body);
    if (input.name_styled && input.name_styled.toLowerCase() !== community.name) {
        throw badRequest('Only capital letters can change: the letters must stay the same as the name.', 'name_style_mismatch');
    }

    const updated = await prisma.community.update({
        where: { id: community.id },
        data: input,
    });
    await prisma.modAction.create({
        data: {
            actor_id: user.id,
            community_id: community.id,
            action: 'update_community',
            target_type: 'community',
            target_id: community.id,
            details: { fields: Object.keys(input) },
        },
    });
    response.json({ community: toPublicCommunity(updated) });
});

router.get('/:name/posts', optionalAuth, async (request: AuthRequest, response) => {
    const query = parse(communityPostsQuery, request.query);
    const community = await findCommunity(String(request.params.name));
    await assertCanView(community, request.viewer?.user);
    const context = await viewerContext(request.viewer);

    // Pinned posts lead the first page of the default sort
    const showPinned = query.sort === 'hot' && !query.cursor;
    const pinnedRows = showPinned
        ? await prisma.post.findMany({
              where: { community_id: community.id, status: { in: LISTED_POST_STATUSES }, pinned_at: { not: null }, ...notShadowHidden(context) },
              orderBy: { pinned_at: 'desc' },
              take: 2,
              include: postInclude,
          })
        : [];

    const page = await listPosts({
        where: { community_id: community.id, ...(showPinned ? { NOT: { id: { in: pinnedRows.map((post) => post.id) } } } : {}) },
        sort: query.sort,
        window: query.t,
        cursor: query.cursor,
        limit: query.limit,
        context,
    });
    response.json({ posts: [...(await serializePosts(pinnedRows, context)), ...page.posts], next_cursor: page.next_cursor });
});

// Join. Private communities get a join request for the moderators instead.
router.put('/:name/membership', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    if (community.status !== 'active') throw forbidden('This community is archived.', 'community_archived');
    const input = parse(joinSchema, request.body);

    const member = await findMembership(community.id, user.id);
    if (isBanned(member)) throw forbidden('You are banned from this community.', 'banned');
    if (member) throw conflict('You are already a member.', 'already_member');

    if (community.visibility === 'private' && user.role !== 'admin') {
        const existing = await prisma.communityJoinRequest.findUnique({
            where: { community_id_user_id: { community_id: community.id, user_id: user.id } },
        });
        if (existing?.status === 'pending') throw conflict('Your request is waiting for a moderator.', 'request_pending');
        await prisma.communityJoinRequest.upsert({
            where: { community_id_user_id: { community_id: community.id, user_id: user.id } },
            create: { community_id: community.id, user_id: user.id, message: input.message ?? null },
            update: { status: 'pending', message: input.message ?? null, responded_by: null, responded_at: null },
        });
        return response.status(202).json({ status: 'requested' });
    }

    await joinCommunity(community.id, user.id);
    response.json({ status: 'joined' });
});

async function joinCommunity(communityId: string, userId: string) {
    await prisma.$transaction([
        prisma.communityMember.create({ data: { community_id: communityId, user_id: userId } }),
        prisma.community.update({ where: { id: communityId }, data: { member_count: { increment: 1 } } }),
    ]);
}

router.delete('/:name/membership', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    const member = await findMembership(community.id, user.id);
    if (!member || isBanned(member)) throw notFound('You are not a member of this community.', 'not_member');
    if (member.role === 'owner') {
        throw badRequest('Owners must hand the community to someone else before leaving.', 'owner_cannot_leave');
    }
    await prisma.$transaction([
        prisma.communityMember.delete({ where: { community_id_user_id: { community_id: community.id, user_id: user.id } } }),
        prisma.community.update({ where: { id: community.id }, data: { member_count: { decrement: 1 } } }),
    ]);
    response.json({ status: 'left' });
});

router.get('/:name/join-requests', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    await assertModerator(community.id, user);
    const requests = await prisma.communityJoinRequest.findMany({
        where: { community_id: community.id, status: 'pending' },
        orderBy: { created_at: 'asc' },
        take: 100,
        select: { id: true, message: true, created_at: true, user: { select: { username: true, avatar_id: true, created_at: true } } },
    });
    response.json({ requests });
});

router.post('/:name/join-requests/:id', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    await assertModerator(community.id, user);
    const { decision } = parse(joinDecisionSchema, request.body);

    const joinRequest = await prisma.communityJoinRequest.findFirst({
        where: { id: uuidParam(request.params.id, 'Request not found'), community_id: community.id, status: 'pending' },
    });
    if (!joinRequest) throw notFound('Request not found');

    await prisma.communityJoinRequest.update({
        where: { id: joinRequest.id },
        data: { status: decision === 'accept' ? 'accepted' : 'rejected', responded_by: user.id, responded_at: new Date() },
    });
    if (decision === 'accept' && !(await findMembership(community.id, joinRequest.user_id))) {
        await joinCommunity(community.id, joinRequest.user_id);
    }
    response.json({ status: decision === 'accept' ? 'accepted' : 'rejected' });
});

// Owner promotes or demotes a moderator
router.put('/:name/members/:username/role', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    await assertOwner(community.id, user);
    const { role } = parse(roleSchema, request.body);

    const target = await prisma.user.findUnique({ where: { username: String(request.params.username).toLowerCase() } });
    const member = target ? await findMembership(community.id, target.id) : null;
    if (!target || !isActiveMember(member)) throw notFound('That user is not a member of this community.', 'not_member');
    if (member.role === 'owner') throw badRequest("The owner's role can't be changed here.", 'owner_role');

    await prisma.$transaction([
        prisma.communityMember.update({
            where: { community_id_user_id: { community_id: community.id, user_id: target.id } },
            data: { role },
        }),
        prisma.modAction.create({
            data: {
                actor_id: user.id,
                community_id: community.id,
                action: 'set_role',
                target_type: 'user',
                target_id: target.id,
                details: { role },
            },
        }),
    ]);
    response.json({ username: target.username, role });
});

router.post('/:name/bans', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    const actor = await assertModerator(community.id, user);
    const input = parse(banSchema, request.body);

    const target = await prisma.user.findUnique({ where: { username: input.username } });
    if (!target) throw notFound('User not found');
    if (target.id === user.id) throw badRequest("You can't ban yourself.", 'self_ban');
    const existing = await findMembership(community.id, target.id);
    // Moderators can ban members; only the owner (or an admin) can ban a moderator; nobody bans the owner
    if (existing?.role === 'owner') throw forbidden("The owner can't be banned.", 'cannot_ban_owner');
    if (existing?.role === 'moderator' && actor && actor.role !== 'owner') {
        throw forbidden('Only the owner can ban a moderator.', 'cannot_ban_moderator');
    }

    const until = input.days ? new Date(Date.now() + input.days * 24 * 60 * 60 * 1000) : null;
    const wasCounted = isActiveMember(existing);
    await prisma.$transaction([
        prisma.communityMember.upsert({
            where: { community_id_user_id: { community_id: community.id, user_id: target.id } },
            create: { community_id: community.id, user_id: target.id, is_banned: true, banned_until: until, ban_reason: input.reason ?? null },
            update: { role: 'member', is_banned: true, banned_until: until, ban_reason: input.reason ?? null },
        }),
        ...(wasCounted
            ? [prisma.community.update({ where: { id: community.id }, data: { member_count: { decrement: 1 } } })]
            : []),
        prisma.modAction.create({
            data: {
                actor_id: user.id,
                community_id: community.id,
                action: 'ban_user',
                target_type: 'user',
                target_id: target.id,
                reason: input.reason ?? null,
                details: { until: until?.toISOString() ?? null },
            },
        }),
    ]);
    response.json({ username: target.username, banned_until: until });
});

// Lifting a ban removes the row entirely; the user can join again
router.delete('/:name/bans/:username', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    await assertModerator(community.id, user);
    const target = await prisma.user.findUnique({ where: { username: String(request.params.username).toLowerCase() } });
    const member = target ? await findMembership(community.id, target.id) : null;
    if (!target || !member?.is_banned) throw notFound('That user is not banned here.', 'not_banned');

    await prisma.$transaction([
        prisma.communityMember.delete({ where: { community_id_user_id: { community_id: community.id, user_id: target.id } } }),
        prisma.modAction.create({
            data: { actor_id: user.id, community_id: community.id, action: 'unban_user', target_type: 'user', target_id: target.id },
        }),
    ]);
    response.json({ success: true });
});

router.get('/:name/flairs', async (request, response) => {
    const community = await findCommunity(String(request.params.name));
    const flairs = await prisma.flair.findMany({
        where: { community_id: community.id },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, color: true },
    });
    response.json({ flairs });
});

router.post('/:name/flairs', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    await assertModerator(community.id, user);
    const input = parse(flairSchema, request.body);
    if ((await prisma.flair.count({ where: { community_id: community.id } })) >= 50) {
        throw badRequest('A community can have at most 50 flairs.', 'too_many_flairs');
    }
    try {
        const flair = await prisma.flair.create({
            data: { community_id: community.id, name: input.name, color: input.color ?? null },
            select: { id: true, name: true, color: true },
        });
        response.status(201).json({ flair });
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw conflict('That flair already exists.', 'flair_exists');
        }
        throw error;
    }
});

router.delete('/:name/flairs/:id', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    await assertModerator(community.id, user);
    const result = await prisma.flair.deleteMany({
        where: { id: uuidParam(request.params.id, 'Flair not found'), community_id: community.id },
    });
    if (result.count === 0) throw new HttpError(404, 'not_found', 'Flair not found');
    response.json({ success: true });
});

export default router;
