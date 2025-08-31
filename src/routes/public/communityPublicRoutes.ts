import { Router } from 'express';
import prisma from '../../prismaConnection';
import { ErrorResponse } from '../../models/interfaces/errorType';
import DateUtils from '../../utils/dateUtils';
import { AuthRequest } from '../../middlewares/authMiddleware';
import { Community, Moderator, User, ModeratorRole, PostStatus, CommunityStatus } from '@prisma/client';

const router = Router();

/*
    Community routes as /community
    - Get a community by ID
    - Create a community
    - Delete a community
    - Archive a community
    - Unarchive a community
*/

router.get('/:id', async (request: AuthRequest, response) => {
    const { id } = request.params;

    if (!id) {
        return response.status(400).json({ error: 'Community ID is required' } as ErrorResponse);
    }

    try {
        const community = await prisma.community.findUnique({
            where: { id },
            include: {
                moderators: true,
                _count: {
                    select: {
                        members: true,
                        posts: true,
                    },
                },
            },
        });

        if (!community) {
            return response.status(404).json({ error: 'Community not found' } as ErrorResponse);
        }

        return response.status(200).json({ community });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to get community', details: error } as ErrorResponse);
    }
});

export default router;
