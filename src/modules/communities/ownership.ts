import prisma from '../../prismaConnection';
import { onJobsWake } from '../../lib/jobs';
import { SITE_ACCOUNT_NAME, SITE_ACCOUNT_USERNAME } from '../../shared/site';

// Who looks after a community when its owner can't: the site's own account stands in when there's nobody else. It has
// no password, so nobody signs in to it.

export async function siteAccount() {
    return prisma.user.upsert({
        where: { username: SITE_ACCOUNT_USERNAME },
        create: { username: SITE_ACCOUNT_USERNAME, email: 'site-team@invalid.local', display_name: SITE_ACCOUNT_NAME, email_verified_at: new Date() },
        update: {},
    });
}

// A rename of the site reaches the account here
onJobsWake('site-account', () => prisma.user.updateMany({ where: { username: SITE_ACCOUNT_USERNAME, NOT: { display_name: SITE_ACCOUNT_NAME } }, data: { display_name: SITE_ACCOUNT_NAME } }));

// Moves ownership of one community, keeping the old owner as `previousRole`. Logged when given an action (the admin
// panel logs its own).
export async function setOwner(communityId: string, newOwnerId: string, options: { action?: string; actorId?: string; previousRole?: 'moderator' | 'member'; needsModerator?: boolean } = {}) {
    const { action, actorId, previousRole = 'moderator', needsModerator = false } = options;
    await prisma.$transaction(async (tx) => {
        const owner = await tx.communityMember.findFirst({ where: { community_id: communityId, role: 'owner' }, select: { user_id: true } });
        await tx.communityMember.updateMany({ where: { community_id: communityId, role: 'owner' }, data: { role: previousRole, mod_permission: 'all' } });
        const existing = await tx.communityMember.findUnique({ where: { community_id_user_id: { community_id: communityId, user_id: newOwnerId } } });
        if (existing) {
            await tx.communityMember.update({
                where: { community_id_user_id: { community_id: communityId, user_id: newOwnerId } },
                data: { role: 'owner', mod_permission: 'all', is_banned: false, banned_until: null, ban_reason: null },
            });
        } else {
            await tx.communityMember.create({ data: { community_id: communityId, user_id: newOwnerId, role: 'owner' } });
        }
        await tx.community.update({
            where: { id: communityId },
            data: { needs_moderator: needsModerator, ...(existing ? {} : { member_count: { increment: 1 } }) },
        });
        if (action) {
            await tx.modAction.create({
                data: {
                    actor_id: actorId ?? null,
                    community_id: communityId,
                    action,
                    target_type: 'user',
                    target_id: newOwnerId,
                    details: { previous_owner: owner?.user_id ?? null },
                },
            });
        }
    });
}

// When an owner goes for good: the longest-serving Lead or full moderator takes over, otherwise the site account, and
// the admins are told the community needs a moderator
export async function handOverOwnership(ownerId: string) {
    const owned = await prisma.communityMember.findMany({ where: { user_id: ownerId, role: 'owner' }, select: { community_id: true } });
    for (const { community_id } of owned) {
        const moderators = await prisma.communityMember.findMany({
            where: { community_id, role: 'moderator', mod_permission: { not: 'posts' }, is_banned: false, user: { status: 'active' } },
            orderBy: { joined_at: 'asc' },
            select: { user_id: true, mod_permission: true },
        });
        const successor = moderators.find((mod) => mod.mod_permission === 'lead') ?? moderators[0];
        await setOwner(community_id, successor?.user_id ?? (await siteAccount()).id, {
            action: 'auto_transfer_ownership',
            previousRole: 'member',
            needsModerator: !successor,
        });
    }
}
