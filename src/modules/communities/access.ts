import { Community, CommunityMember, User } from '@prisma/client';
import prisma from '../../prismaConnection';
import { forbidden, HttpError, notFound } from '../../lib/http';
import { Viewer } from '../../middlewares/auth';

// What a request knows about who is looking: used by every serializer to decide what to reveal
export type ViewerContext = { userId: string; isAdmin: boolean; moderates: Set<string> } | null;

export async function viewerContext(viewer: Viewer | undefined): Promise<ViewerContext> {
    if (!viewer) return null;
    const rows = await prisma.communityMember.findMany({
        where: { user_id: viewer.user.id, role: { in: ['moderator', 'owner'] }, is_banned: false },
        select: { community_id: true },
    });
    return {
        userId: viewer.user.id,
        isAdmin: viewer.user.role === 'admin',
        moderates: new Set(rows.map((row) => row.community_id)),
    };
}

export const canModerate = (context: ViewerContext, communityId: string) =>
    Boolean(context && (context.isAdmin || context.moderates.has(communityId)));

export async function findCommunity(name: string) {
    const community = await prisma.community.findUnique({ where: { name: name.toLowerCase() } });
    if (!community || community.status === 'deleted') throw notFound('Community not found');
    return community;
}

export async function findMembership(communityId: string, userId: string | undefined) {
    if (!userId) return null;
    return prisma.communityMember.findUnique({ where: { community_id_user_id: { community_id: communityId, user_id: userId } } });
}

export const isBanned = (member: CommunityMember | null) =>
    Boolean(member?.is_banned && (!member.banned_until || member.banned_until > new Date()));

export const isActiveMember = (member: CommunityMember | null): member is CommunityMember =>
    Boolean(member) && !isBanned(member);

// Private communities are visible to their members and site admins only
export async function assertCanView(community: Community, user: User | undefined) {
    if (community.visibility === 'public' || user?.role === 'admin') return;
    if (!isActiveMember(await findMembership(community.id, user?.id))) {
        throw new HttpError(403, 'private_community', 'This community is private.');
    }
}

// Posting, commenting and voting
export async function assertCanParticipate(community: Community, user: User) {
    if (community.status !== 'active') throw forbidden('This community is archived.', 'community_archived');
    const member = await findMembership(community.id, user.id);
    if (isBanned(member)) throw forbidden('You are banned from this community.', 'banned');
    if (community.visibility === 'private' && !member && user.role !== 'admin') {
        throw new HttpError(403, 'private_community', 'This community is private.');
    }
}

export async function assertModerator(communityId: string, user: User) {
    if (user.role === 'admin') return null;
    const member = await findMembership(communityId, user.id);
    if (!member || isBanned(member) || member.role === 'member') {
        throw forbidden('Only moderators can do that.', 'not_moderator');
    }
    return member;
}

export async function assertOwner(communityId: string, user: User) {
    if (user.role === 'admin') return;
    const member = await findMembership(communityId, user.id);
    if (member?.role !== 'owner') throw forbidden('Only the community owner can do that.', 'not_owner');
}
