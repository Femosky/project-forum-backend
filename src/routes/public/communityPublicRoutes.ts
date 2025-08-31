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

function getSortOrder(sort: string) {
    switch (sort) {
        case 'newest':
            return { created_at: 'desc' };
        case 'oldest':
            return { created_at: 'asc' };
        case 'trending':
            return {
                upvoters: { _count: 'desc' },
                created_at: 'desc',
            };
        case 'most_commented':
            return {
                comments: { _count: 'desc' },
                created_at: 'desc',
            };
        default:
            return { created_at: 'desc' };
    }
}

// Get posts for a community with pagination
router.get('/:community_name', async (request, response) => {
    const { community_name } = request.params;
    const { page = '1', limit = '10', sort_by = 'newest', sort_order = 'desc' } = request.query;

    try {
        console.log('i is came here');
        const community = await prisma.community.findUnique({
            where: { name: community_name.toLowerCase() },
        });
        if (!community) {
            return response.status(404).json({ error: 'Community not found' });
        }

        const pageNumber = parseInt(page as string);
        const limitNumber = parseInt(limit as string);
        const offset = (pageNumber - 1) * limitNumber;

        const posts = await prisma.post.findMany({
            where: { community_id: community.id },
            take: limitNumber,
            skip: offset,
            orderBy: getSortOrder(sort_by as string) as any,
            include: {
                author_ref: {
                    select: { username: true, avatar_id: true },
                },
                _count: {
                    select: { comments: true, upvoters: true, downvoters: true },
                },
            },
        });

        if (!posts) {
            return response.status(404).json({ error: 'Posts not found' });
        }

        const totalPosts = await prisma.post.count({
            where: { community_id: community.id },
        });

        const totalPages = Math.ceil(totalPosts / limitNumber);

        response.json({
            posts,
            pagination: {
                current_page: pageNumber,
                total_pages: totalPages,
                total_posts: totalPosts,
                has_next_page: pageNumber < totalPages,
                has_previous_page: pageNumber > 1,
                next_page: pageNumber + 1,
                previous_page: pageNumber - 1,
            },
        });
    } catch (error) {
        response.status(500).json({ error: 'Failed to get posts', details: error } as ErrorResponse);
    }
});

export default router;
