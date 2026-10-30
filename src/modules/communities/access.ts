import { Community, CommunityMember, Prisma, User } from '@prisma/client';
import prisma from '../../prismaConnection';
import { forbidden, HttpError, notFound } from '../../lib/http';
import { Viewer } from '../../middlewares/auth';

// What a request knows about who is looking: used by every serializer to decide what to reveal.
// showMature: the viewer switched on "Show mature content" (lists include NSFW posts and communities, unblurred)
export type ViewerContext = { userId: string; isAdmin: boolean; moderates: Set<string>; showMature: boolean } | null;

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
        showMature: viewer.user.show_mature,
    };
}

// Mature (NSFW) posts and communities only appear in lists (feeds, search, the directory) for viewers who asked for
// them; everyone else, guests included, can still open them directly, behind a blur
export const showsMature = (context: ViewerContext) => Boolean(context?.showMature);
export const notMaturePost = (context: ViewerContext): Prisma.PostWhereInput =>
    showsMature(context) ? {} : { is_nsfw: false, community: { is_nsfw: false } };
export const notMatureCommunity = (context: ViewerContext): Prisma.CommunityWhereInput => (showsMature(context) ? {} : { is_nsfw: false });

export const canModerate = (context: ViewerContext, communityId: string) =>
    Boolean(context && (context.isAdmin || context.moderates.has(communityId)));

// A community by name, in any case (names are citext), or by an old name it was renamed from. Callers that show a
// page compare the returned name with what was asked for and redirect to the canonical one.
export async function findCommunity(name: string) {
    const community =
        (await prisma.community.findUnique({ where: { name } })) ??
        (await prisma.communityAlias.findUnique({ where: { name }, include: { community: true } }))?.community;
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

export async function activeMute(communityId: string, userId: string) {
    const mute = await prisma.communityMute.findUnique({ where: { community_id_user_id: { community_id: communityId, user_id: userId } } });
    return mute && mute.muted_until > new Date() ? mute : null;
}

// Posting and commenting: everything assertCanParticipate checks, plus community mutes
export async function assertCanPost(community: Community, user: User) {
    await assertCanParticipate(community, user);
    const mute = await activeMute(community.id, user.id);
    if (mute) {
        throw forbidden(`You are muted in this community until ${mute.muted_until.toUTCString()}.`, 'muted');
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

// Everything but the queue and reports: bans, mutes, join requests, settings. Posts-only moderators can't do these.
export async function assertFullModerator(communityId: string, user: User) {
    const member = await assertModerator(communityId, user);
    if (member && member.role === 'moderator' && member.mod_permission === 'posts') {
        throw forbidden('Your moderator role covers posts only.', 'posts_only_moderator');
    }
    return member;
}

// Inviting, changing and removing moderators: the owner and Lead mods
export async function assertTeamManager(communityId: string, user: User) {
    const member = await assertModerator(communityId, user);
    if (member && member.role === 'moderator' && member.mod_permission !== 'lead') {
        throw forbidden('Only the owner and Lead mods can do that.', 'not_lead_moderator');
    }
    return member;
}

export async function assertOwner(communityId: string, user: User) {
    if (user.role === 'admin') return;
    const member = await findMembership(communityId, user.id);
    if (member?.role !== 'owner') throw forbidden('Only the community owner can do that.', 'not_owner');
}
