import { Router } from 'express';
import { CommunityMember, ModPermission, User } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../prismaConnection';
import { env } from '../../config/env';
import { linkEmail } from '../../lib/email';
import { badRequest, conflict, forbidden, notFound, parse, uuidParam } from '../../lib/http';
import { avatarCode } from '../../lib/avatars';
import { AuthRequest, requireAuth, viewerOf } from '../../middlewares/auth';
import { username } from '../../shared/validation';
import { emailJob } from '../auth/jobs';
import { assertModerator, assertOwner, assertTeamManager, findCommunity, findMembership, isActiveMember } from '../communities/access';
import { setOwner } from '../communities/ownership';
import { queueCount } from './queue';

// A community's moderators (invite, permissions, remove, hand over ownership) and the page that lists everything a
// person moderates. The owner and Lead mods run the team, only the owner makes Lead mods or hands over the community,
// and each step goes into the mod log.

const router = Router();

const permission = z.enum(['lead', 'all', 'posts']);
const inviteSchema = z.object({ username, permission: permission.default('all') });
const permissionSchema = z.object({ permission });
const decisionSchema = z.object({ decision: z.enum(['accept', 'decline']) });
const transferSchema = z.object({ username });
const emailSchema = z.object({ frequency: z.enum(['instant', 'daily', 'off']) });

function log(actorId: string, communityId: string, action: string, targetId: string, details?: Record<string, string>) {
    return prisma.modAction.create({ data: { actor_id: actorId, community_id: communityId, action, target_type: 'user', target_id: targetId, details } });
}

// Lead is the owner's to give and take away (a null manager is a site admin)
function assertMayGrant(manager: CommunityMember | null, level: ModPermission) {
    if (level === 'lead' && manager?.role === 'moderator') throw forbidden('Only the owner can do that for a Lead mod.', 'not_owner');
}

async function findTarget(communityId: string, name: string) {
    const target = await prisma.user.findUnique({ where: { username: name.toLowerCase() } });
    const member = target ? await findMembership(communityId, target.id) : null;
    return { target, member };
}

// Everything the signed-in person moderates, with what's waiting, plus invitations to answer
router.get('/moderation/overview', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const [memberships, invites, settings] = await Promise.all([
        prisma.communityMember.findMany({
            where: { user_id: user.id, role: { in: ['owner', 'moderator'] }, is_banned: false },
            orderBy: { joined_at: 'asc' },
            select: { role: true, mod_permission: true, community: { select: { id: true, name: true, display_name: true, image_url: true, visibility: true } } },
        }),
        prisma.modInvite.findMany({
            where: { user_id: user.id, status: 'pending' },
            select: { id: true, permission: true, inviter: { select: { username: true } }, community: { select: { name: true, display_name: true } } },
        }),
        prisma.modEmailSetting.findMany({ where: { user_id: user.id }, select: { community_id: true, frequency: true } }),
    ]);
    const communities = await Promise.all(
        memberships.map(async ({ role, mod_permission, community: { id, ...community } }) => {
            const [queue, join_requests] = await Promise.all([
                queueCount({ communityId: id }),
                prisma.communityJoinRequest.count({ where: { community_id: id, status: 'pending' } }),
            ]);
            const permissionShown = role === 'owner' ? 'all' : mod_permission;
            return {
                ...community,
                role,
                permission: permissionShown,
                queue,
                join_requests: permissionShown === 'posts' ? 0 : join_requests,
                email: settings.find((row) => row.community_id === id)?.frequency ?? 'daily',
            };
        })
    );
    const total = communities.reduce((sum, row) => sum + row.queue + row.join_requests, 0) + invites.length;
    response.json({ communities, invites, total });
});

router.post('/moderation/invites/:id', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const { decision } = parse(decisionSchema, request.body);
    const invite = await prisma.modInvite.findFirst({ where: { id: uuidParam(request.params.id, 'Invitation not found'), user_id: user.id, status: 'pending' } });
    if (!invite) throw notFound('Invitation not found');
    if (decision === 'decline') {
        await prisma.$transaction([
            prisma.modInvite.update({ where: { id: invite.id }, data: { status: 'declined' } }),
            log(user.id, invite.community_id, 'decline_mod_invite', user.id),
        ]);
        return response.json({ status: 'declined' });
    }
    const member = await findMembership(invite.community_id, user.id);
    if (member?.is_banned) throw forbidden('You are banned from this community.', 'banned');
    await prisma.$transaction([
        prisma.modInvite.update({ where: { id: invite.id }, data: { status: 'accepted' } }),
        member
            ? prisma.communityMember.update({
                  where: { community_id_user_id: { community_id: invite.community_id, user_id: user.id } },
                  data: { role: 'moderator', mod_permission: invite.permission },
              })
            : prisma.communityMember.create({ data: { community_id: invite.community_id, user_id: user.id, role: 'moderator', mod_permission: invite.permission } }),
        ...(member ? [] : [prisma.community.update({ where: { id: invite.community_id }, data: { member_count: { increment: 1 } } })]),
        log(user.id, invite.community_id, 'accept_mod_invite', user.id, { permission: invite.permission }),
    ]);
    response.json({ status: 'accepted' });
});

router.put('/communities/:name/mod-email', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    await assertModerator(community.id, user);
    const { frequency } = parse(emailSchema, request.body);
    await prisma.modEmailSetting.upsert({
        where: { community_id_user_id: { community_id: community.id, user_id: user.id } },
        create: { community_id: community.id, user_id: user.id, frequency },
        update: { frequency },
    });
    response.json({ frequency });
});

router.get('/communities/:name/team', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    await assertModerator(community.id, user);
    const [members, invites] = await Promise.all([
        prisma.communityMember.findMany({
            where: { community_id: community.id, role: { in: ['owner', 'moderator'] }, is_banned: false },
            orderBy: { joined_at: 'asc' },
            select: { role: true, mod_permission: true, joined_at: true, user: { select: { username: true, avatar_config: true } } },
        }),
        prisma.modInvite.findMany({
            where: { community_id: community.id, status: 'pending' },
            select: { id: true, permission: true, created_at: true, user: { select: { username: true } } },
        }),
    ]);
    response.json({
        moderators: members.map(({ role, mod_permission, joined_at, user: { username: name, avatar_config } }) => ({
            username: name,
            avatar: avatarCode(avatar_config, name),
            role,
            permission: role === 'owner' ? 'all' : mod_permission,
            joined_at,
        })),
        invites: invites.map(({ user: invitee, ...invite }) => ({ ...invite, username: invitee.username })),
    });
});

router.post('/communities/:name/team/invites', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    const manager = await assertTeamManager(community.id, user);
    const input = parse(inviteSchema, request.body);
    assertMayGrant(manager, input.permission);
    const { target, member } = await findTarget(community.id, input.username);
    if (!target || target.status !== 'active') throw notFound('No one has that username.', 'user_not_found');
    if (isActiveMember(member) && member.role !== 'member') throw conflict('They are already a moderator here.', 'already_moderator');
    if (member?.is_banned) throw forbidden('They are banned from this community.', 'banned');

    const invite = await prisma.modInvite.upsert({
        where: { community_id_user_id: { community_id: community.id, user_id: target.id } },
        create: { community_id: community.id, user_id: target.id, invited_by: user.id, permission: input.permission },
        update: { invited_by: user.id, permission: input.permission, status: 'pending' },
    });
    await prisma.$transaction([
        prisma.notification.create({ data: { user_id: target.id, actor_id: user.id, community_id: community.id, type: 'mod_invite' } }),
        log(user.id, community.id, 'invite_mod', target.id, { permission: input.permission }),
    ]);
    await emailJob.enqueue(
        linkEmail(
            target.email,
            `You've been invited to moderate c/${community.name}`,
            `${user.username} invited you to help moderate c/${community.name}.`,
            'See the invitation',
            `${env.WEB_URL}/moderation`
        )
    );
    response.status(201).json({ id: invite.id, username: target.username, permission: invite.permission });
});

router.delete('/communities/:name/team/invites/:id', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    await assertTeamManager(community.id, user);
    const invite = await prisma.modInvite.findFirst({ where: { id: uuidParam(request.params.id, 'Invitation not found'), community_id: community.id, status: 'pending' } });
    if (!invite) throw notFound('Invitation not found');
    await prisma.$transaction([
        prisma.modInvite.update({ where: { id: invite.id }, data: { status: 'cancelled' } }),
        prisma.notification.deleteMany({ where: { user_id: invite.user_id, community_id: community.id, type: 'mod_invite' } }),
        log(user.id, community.id, 'cancel_mod_invite', invite.user_id),
    ]);
    response.json({ success: true });
});

router.patch('/communities/:name/team/:username', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    const manager = await assertTeamManager(community.id, user);
    const input = parse(permissionSchema, request.body);
    const { target, member } = await findTarget(community.id, String(request.params.username));
    if (!target || !isActiveMember(member) || member.role !== 'moderator') throw notFound('They are not a moderator here.', 'not_moderator');
    assertMayGrant(manager, input.permission);
    assertMayGrant(manager, member.mod_permission);
    await prisma.$transaction([
        prisma.communityMember.update({
            where: { community_id_user_id: { community_id: community.id, user_id: target.id } },
            data: { mod_permission: input.permission },
        }),
        log(user.id, community.id, 'set_mod_permission', target.id, { permission: input.permission }),
    ]);
    response.json({ username: target.username, permission: input.permission });
});

// The owner removes a moderator, or a moderator steps down. They stay a member.
async function stepDown(actor: User, communityId: string, target: User) {
    await prisma.$transaction([
        prisma.communityMember.update({
            where: { community_id_user_id: { community_id: communityId, user_id: target.id } },
            data: { role: 'member', mod_permission: 'all' },
        }),
        log(actor.id, communityId, actor.id === target.id ? 'step_down' : 'remove_mod', target.id),
    ]);
}

router.delete('/communities/:name/team/:username', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    const { target, member } = await findTarget(community.id, String(request.params.username));
    const manager = target?.id === user.id ? null : await assertTeamManager(community.id, user);
    if (!target || !isActiveMember(member) || member.role !== 'moderator') throw notFound('They are not a moderator here.', 'not_moderator');
    if (target.id !== user.id) assertMayGrant(manager, member.mod_permission);
    await stepDown(user, community.id, target);
    response.json({ success: true });
});

router.post('/communities/:name/transfer', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    await assertOwner(community.id, user);
    const input = parse(transferSchema, request.body);
    const { target, member } = await findTarget(community.id, input.username);
    if (!target || !isActiveMember(member) || member.role !== 'moderator') throw badRequest('Ownership can only go to a current moderator.', 'not_moderator');
    await setOwner(community.id, target.id, { action: 'transfer_ownership', actorId: user.id });
    response.json({ owner: target.username });
});

export default router;
