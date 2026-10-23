import prisma from '../prismaConnection';

export class ModeratorService {
    // Returns the caller's own active moderator row for a community, or null.
    // Never trust a moderator ID sent by the client.
    static async getActiveModerator(userId: string, communityId: string) {
        return prisma.moderator.findFirst({
            where: { user_id: userId, community_id: communityId, is_active: true, is_removed: false },
        });
    }
}
