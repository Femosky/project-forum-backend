import { Router } from 'express';
import { AuthRequest } from '../../middlewares/authMiddleware';
import { ErrorResponse } from '../../models/interfaces/errorType';
import prisma from '../../prismaConnection';
import { Community, Moderator, User, ModeratorRole, PostStatus, CommunityStatus } from '@prisma/client';

const router = Router();

router.post('/join', async (request: AuthRequest, response) => {
    const { community_id, request_message } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!community_id) {
        return response.status(400).json({ error: 'Community ID is required' } as ErrorResponse);
    }

    try {
        const community = (await prisma.community.findUnique({
            where: { id: community_id },
        })) as Community & { _count: { members: number } };

        if (!community) {
            return response.status(404).json({ error: 'Community not found' } as ErrorResponse);
        }

        const isUserAlreadyMember = await prisma.community.findFirst({
            where: {
                members: {
                    some: { id: user.id },
                },
            },
        });

        if (isUserAlreadyMember) {
            return response.status(400).json({ error: 'User is already a member of the community' } as ErrorResponse);
        }

        if (community.is_archived) {
            return response.status(400).json({ error: 'Community is archived' } as ErrorResponse);
        } else if (community.is_deleted) {
            return response.status(400).json({ error: 'Community is deleted' } as ErrorResponse);
        }

        //  Join user to community if community is open, otherwise require community join request
        if (community.status === CommunityStatus.closed) {
            return response.status(400).json({ error: 'Community is closed' } as ErrorResponse);
        } else if (community.status === CommunityStatus.private) {
            // Check if user has already requested to join the community
            const existingJoinRequest = await prisma.communityJoinRequest.findFirst({
                where: {
                    requester_id: user.id,
                    community_id: community_id,
                },
            });

            if (existingJoinRequest) {
                return response
                    .status(400)
                    .json({ error: 'User has already requested to join the community' } as ErrorResponse);
            }

            // Require community join request
            const joinRequest = await prisma.communityJoinRequest.create({
                data: {
                    requester_id: user.id,
                    community_id: community_id,
                    request_message,
                },
            });

            if (!joinRequest) {
                return response.status(500).json({ error: 'Failed to create community join request' } as ErrorResponse);
            }

            return response.status(200).json({ message: 'Community join request created successfully' });
        } else {
            const joined = await prisma.user.update({
                where: { id: user.id },
                data: {
                    joined_communities: {
                        connect: { id: community_id },
                    },
                },
            });

            if (!joined) {
                return response.status(500).json({ error: 'Failed to join community' } as ErrorResponse);
            }

            return response.status(200).json({ message: 'User joined community successfully' });
        }
    } catch (error) {
        return response.status(500).json({ error: 'Failed to join community', details: error } as ErrorResponse);
    }
});

router.post('/create-community', async (request: AuthRequest, response) => {
    const { image_url, name, description, seo_metadata, preferences } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!name) {
        return response.status(400).json({ error: 'Name is required' } as ErrorResponse);
    }

    try {
        // Check if user is at least 30 days old
        // if (!DateUtils.isAgeGreaterThan30Days(user)) {
        //     return response.status(400).json({ error: 'User must be at least 30 days old' } as ErrorResponse);
        // }

        // Check if community already exists
        const existingCommunity = await prisma.community.findUnique({
            where: { name },
        });

        if (existingCommunity) {
            return response.status(400).json({ error: 'Community already exists' } as ErrorResponse);
        }

        // Create community
        const community = await prisma.community.create({
            data: {
                created_by: user.id,
                name,
                description,
                image_url,
                seo_metadata,
                preferences,
            },
        });

        if (!community) {
            return response.status(500).json({ error: 'Failed to create community' });
        }

        return response.status(200).json({ message: 'Community created successfully', community });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to create community', details: error } as ErrorResponse);
    }
});

router.delete('/delete-community', async (request: AuthRequest, response) => {
    const { community_id } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!community_id) {
        return response.status(400).json({ error: 'Community ID is required' } as ErrorResponse);
    }

    try {
        // Check if community exists
        const community = await prisma.community.findUnique({
            where: { id: community_id },
            include: {
                _count: {
                    select: {
                        posts: true,
                    },
                },
            },
        });

        if (!community) {
            return response.status(400).json({ error: 'Community not found' } as ErrorResponse);
        }

        // Check if user is the creator of the community
        if (community.created_by !== user.id) {
            return response.status(400).json({ error: 'User is not the creator of the community' } as ErrorResponse);
        }

        // Delete community, deletes the community if no posts, marks it as deleted if there are posts
        if (community._count.posts > 1) {
            return response.status(400).json({ error: 'Community has posts, cannot be erased' } as ErrorResponse);
        } else {
            const isCommunityDeleted = await prisma.community.delete({
                where: { id: community_id },
            });

            if (!isCommunityDeleted) {
                return response.status(500).json({ error: 'Failed to delete community' } as ErrorResponse);
            }
        }

        return response.status(200).json({ message: 'Community deleted or marked as deleted successfully' });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to delete community', details: error } as ErrorResponse);
    }
});

router.post('/archive-community', async (request: AuthRequest, response) => {
    const { community_id } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!community_id) {
        return response.status(400).json({ error: 'Community ID is required' } as ErrorResponse);
    }

    try {
        // Check if community exists
        const community = (await prisma.community.findUnique({
            where: { id: community_id },
            include: {
                moderators: true,
            },
        })) as Community & { moderators: Moderator[] };

        if (!community) {
            return response.status(400).json({ error: 'Community not found' } as ErrorResponse);
        }

        function isUserModerator(community: Community & { moderators: Moderator[] }, user: User): boolean {
            const moderators = community.moderators;

            for (const moderator of moderators) {
                if (moderator.user_id === user.id) {
                    return true;
                }
            }

            return false;
        }

        // Check if user is the creator of the community
        if (community.created_by !== user.id && !isUserModerator(community, user)) {
            return response
                .status(400)
                .json({ error: 'User is not the creator of the community or a moderator' } as ErrorResponse);
        }

        // Archive community
        const isCommunityArchived = await prisma.community.update({
            where: { id: community_id },
            data: {
                is_archived: true,
            },
        });

        if (!isCommunityArchived) {
            return response.status(500).json({ error: 'Failed to archive community' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Community archived successfully' });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to archive community', details: error } as ErrorResponse);
    }
});

router.post('/join-request-response', async (request: AuthRequest, response) => {
    const { community_join_request_id, response_message } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!community_join_request_id) {
        return response.status(400).json({ error: 'Community join request ID is required' } as ErrorResponse);
    }

    try {
        // Check if community join request exists
        const communityJoinRequest = await prisma.communityJoinRequest.findUnique({
            where: { id: community_join_request_id },
        });

        if (!communityJoinRequest) {
            return response.status(400).json({ error: 'Community join request not found' } as ErrorResponse);
        }

        // Check if user is the target of the community join request
        if (communityJoinRequest.requester_id !== user.id) {
            return response
                .status(400)
                .json({ error: 'User is not the target of the community join request' } as ErrorResponse);
        }

        // Respond to community join request
        const isCommunityJoinRequestResponded = await prisma.communityJoinRequest.update({
            where: { id: community_join_request_id },
            data: {
                response_message,
            },
        });

        if (!isCommunityJoinRequestResponded) {
            return response.status(500).json({ error: 'Failed to respond to community join request' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Community join request responded successfully' });
    } catch (error) {
        return response
            .status(500)
            .json({ error: 'Failed to respond to community join request', details: error } as ErrorResponse);
    }
});

router.post('/leave-community', async (request: AuthRequest, response) => {
    const { community_id } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!community_id) {
        return response.status(400).json({ error: 'Community ID is required' } as ErrorResponse);
    }

    try {
        // Check if community exists
        const community = await prisma.community.findUnique({
            where: { id: community_id },
        });

        if (!community) {
            return response.status(400).json({ error: 'Community not found' } as ErrorResponse);
        }

        // Check if user is a member of the community
        const isUserMember = await prisma.community.findFirst({
            where: { id: community_id, members: { some: { id: user.id } } },
        });

        if (!isUserMember) {
            return response.status(400).json({ error: 'User is not a member of the community' } as ErrorResponse);
        }

        // Leave community
        const isUserLeftCommunity = await prisma.community.update({
            where: { id: community_id },
            data: {
                members: {
                    disconnect: { id: user.id },
                },
            },
        });

        if (!isUserLeftCommunity) {
            return response.status(500).json({ error: 'Failed to leave community' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'User left community successfully' });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to leave community', details: error } as ErrorResponse);
    }
});

router.post('/remove-member', async (request: AuthRequest, response) => {
    const { community_id, memberId } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!community_id || !memberId) {
        return response.status(400).json({ error: 'Community ID and member ID are required' } as ErrorResponse);
    }

    try {
        // Check if community exists
        const community = await prisma.community.findUnique({
            where: { id: community_id },
        });

        if (!community) {
            return response.status(400).json({ error: 'Community not found' } as ErrorResponse);
        }

        // Check if user is a moderator of the community
        const isUserModerator = await prisma.community.findFirst({
            where: { id: community_id, moderators: { some: { user_id: user.id } } },
        });

        if (!isUserModerator) {
            return response.status(400).json({ error: 'User is not a moderator of the community' } as ErrorResponse);
        }

        // Check if member is a member of the community
        const isMember = await prisma.community.findFirst({
            where: { id: community_id, members: { some: { id: memberId } } },
        });

        if (!isMember) {
            return response.status(400).json({ error: 'Member is not a member of the community' } as ErrorResponse);
        }

        // Remove member from community
        const isMemberRemoved = await prisma.community.update({
            where: { id: community_id },
            data: {
                members: { disconnect: { id: memberId } },
            },
        });

        if (!isMemberRemoved) {
            return response.status(500).json({ error: 'Failed to remove member' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Member removed from community successfully' });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to remove member', details: error } as ErrorResponse);
    }
});

router.post('/add-moderator', async (request: AuthRequest, response) => {
    const { community_id, moderatorId } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!community_id || !moderatorId) {
        return response.status(400).json({ error: 'Community ID and moderator ID are required' } as ErrorResponse);
    }

    try {
        // Check if community exists
        const community = await prisma.community.findUnique({
            where: { id: community_id },
        });

        if (!community) {
            return response.status(400).json({ error: 'Community not found' } as ErrorResponse);
        }

        // Check if moderator is a member of the community
        const isModerator = await prisma.community.findFirst({
            where: { id: community_id, members: { some: { id: moderatorId } } },
        });

        if (!isModerator) {
            return response.status(400).json({ error: 'Moderator is not a member of the community' } as ErrorResponse);
        }

        // Check if user is a moderator of the community
        const isUserModerator = await prisma.community.findFirst({
            where: { id: community_id, moderators: { some: { user_id: user.id } } },
        });

        if (isUserModerator) {
            return response
                .status(400)
                .json({ error: 'User is already a moderator of the community' } as ErrorResponse);
        }

        // Add moderator to community
        const isModeratorAdded = await prisma.community.update({
            where: { id: community_id },
            data: {
                moderators: { connect: { id: moderatorId } },
            },
        });

        if (!isModeratorAdded) {
            return response.status(500).json({ error: 'Failed to add moderator' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Moderator added to community successfully' });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to add moderator', details: error } as ErrorResponse);
    }
});

router.post('/remove-moderator', async (request: AuthRequest, response) => {
    const { community_id, moderatorId } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!community_id || !moderatorId) {
        return response.status(400).json({ error: 'Community ID and moderator ID are required' } as ErrorResponse);
    }

    try {
        // Check if community exists
        const community = await prisma.community.findUnique({
            where: { id: community_id },
        });

        if (!community) {
            return response.status(400).json({ error: 'Community not found' } as ErrorResponse);
        }

        // Check if user is the creator or admin of the community
        const isCreator = await prisma.community.findUnique({
            where: { id: community_id, created_by: user.id },
        });

        const isAdmin = await prisma.community.findFirst({
            where: { id: community_id, moderators: { some: { user_id: user.id, role: ModeratorRole.admin } } },
        });

        if (!isCreator && !isAdmin) {
            return response
                .status(400)
                .json({ error: 'Access denied: User is not the creator or admin of the community' } as ErrorResponse);
        }

        // Check if user is a moderator of the community
        const isUserModerator = await prisma.community.findFirst({
            where: { id: community_id, moderators: { some: { user_id: user.id } } },
        });

        if (!isUserModerator) {
            return response.status(400).json({ error: 'User is not a moderator of the community' } as ErrorResponse);
        }

        // Remove moderator from community
        const isModeratorRemoved = await prisma.community.update({
            where: { id: community_id },
            data: {
                moderators: { disconnect: { id: moderatorId } },
            },
        });

        if (!isModeratorRemoved) {
            return response.status(500).json({ error: 'Failed to remove moderator' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Moderator removed from community successfully' });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to remove moderator', details: error } as ErrorResponse);
    }
});

router.post('/update-moderator-role', async (request: AuthRequest, response) => {
    const { community_id, moderatorId } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!community_id || !moderatorId) {
        return response.status(400).json({ error: 'Community ID and moderator ID are required' } as ErrorResponse);
    }

    try {
        // Check if community exists
        const community = await prisma.community.findUnique({
            where: { id: community_id },
        });

        if (!community) {
            return response.status(400).json({ error: 'Community not found' } as ErrorResponse);
        }

        // Check if user is the creator or admin of the community
        const isCreator = await prisma.community.findUnique({
            where: { id: community_id, created_by: user.id },
        });

        const isAdmin = await prisma.community.findFirst({
            where: { id: community_id, moderators: { some: { user_id: user.id, role: ModeratorRole.admin } } },
        });

        if (!isCreator && !isAdmin) {
            return response
                .status(400)
                .json({ error: 'Access denied: User is not the creator or admin of the community' } as ErrorResponse);
        }

        // Check if moderator is a moderator of the community
        const isModerator = await prisma.community.findFirst({
            where: { id: community_id, moderators: { some: { id: moderatorId } } },
        });

        if (!isModerator) {
            return response
                .status(400)
                .json({ error: 'Moderator is not a moderator of the community' } as ErrorResponse);
        }

        // Update moderator role
        const isModeratorRoleUpdated = await prisma.community.update({
            where: { id: community_id },
            data: {
                moderators: { update: { where: { id: moderatorId }, data: { role: ModeratorRole.admin } } },
            },
        });

        if (!isModeratorRoleUpdated) {
            return response.status(500).json({ error: 'Failed to update moderator role' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Moderator role updated successfully' });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to update moderator role', details: error } as ErrorResponse);
    }
});

router.post('/update-community-status', async (request: AuthRequest, response) => {
    const { community_id, status } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!community_id || !status) {
        return response.status(400).json({ error: 'Community ID and status are required' } as ErrorResponse);
    }

    if (!Object.values(CommunityStatus).includes(status)) {
        return response.status(400).json({ error: 'Invalid status' } as ErrorResponse);
    }

    try {
        // Check if community exists
        const community = await prisma.community.findUnique({
            where: { id: community_id },
        });

        if (!community) {
            return response.status(400).json({ error: 'Community not found' } as ErrorResponse);
        }

        // Check if user is the creator or admin of the community
        const isCreator = await prisma.community.findUnique({
            where: { id: community_id, created_by: user.id },
        });

        const isAdmin = await prisma.community.findFirst({
            where: { id: community_id, moderators: { some: { user_id: user.id, role: ModeratorRole.admin } } },
        });

        if (!isCreator && !isAdmin) {
            return response
                .status(400)
                .json({ error: 'Access denied: User is not the creator or admin of the community' } as ErrorResponse);
        }

        // Update community status
        const isCommunityStatusUpdated = await prisma.community.update({
            where: { id: community_id },
            data: { status },
        });

        if (!isCommunityStatusUpdated) {
            return response.status(500).json({ error: 'Failed to update community status' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Community status updated successfully' });
    } catch (error) {
        return response
            .status(500)
            .json({ error: 'Failed to update community status', details: error } as ErrorResponse);
    }
});

export default router;
