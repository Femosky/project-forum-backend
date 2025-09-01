import { Router } from 'express';
import prisma from '../../prismaConnection';
import { ErrorResponse } from '../../models/interfaces/errorType';
import DateUtils from '../../utils/dateUtils';
import { AuthRequest } from '../../middlewares/authMiddleware';
import { Community, Moderator, User, ModeratorRole, PostStatus, CommunityStatus } from '@prisma/client';
import { CommunityService } from '../services/CommunityService';
import { CommentService } from '../services/CommentService';

const router = Router();

/*
    Community routes as /community
    - Get a community by name
    - Get posts for a community with pagination
*/

// Get community by name
router.get('/:community_name', async (request, response) => {
    const { community_name } = request.params;

    try {
        const community = await prisma.community.findUnique({
            where: { name: community_name.toLowerCase() },
            include: {
                moderators: true,
                _count: {
                    select: { members: true, posts: true },
                },
            },
        });
        if (!community) {
            return response.status(404).json({ error: 'Community not found' });
        }

        return response.status(200).json({ community });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to get community', details: error } as ErrorResponse);
    }
});

interface PostPaginationResponse {
    current_page: number;
    total_pages: number;
    total_posts: number;
    has_next_page: boolean;
    has_previous_page: boolean;
    next_page: number;
    previous_page: number;
}

// Get posts for a community with pagination
router.get('/:community_name/posts', async (request, response) => {
    const { community_name } = request.params;
    const { page = '1', limit = '10', sort_by = 'newest' } = request.query;

    try {
        const community = await prisma.community.findUnique({
            where: { name: community_name.toLowerCase() },
        });
        if (!community) {
            return response.status(404).json({ error: 'Community not found with this name' });
        }

        const pageNumber = Math.max(1, parseInt(page as string) || CommentService.DEFAULT_PAGE_NUMBER);
        const limitNumber = Math.min(Math.max(1, parseInt(limit as string) || CommentService.DEFAULT_LIMIT), 100);
        const offset = (pageNumber - 1) * limitNumber;

        const posts = await prisma.post.findMany({
            where: { community_id: community.id },
            take: limitNumber,
            skip: offset,
            orderBy: CommunityService.getSortOrder(sort_by as string) as any,
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
            return response.status(404).json({ error: 'Community posts not found' });
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
            } as PostPaginationResponse,
        });
    } catch (error) {
        response.status(500).json({ error: 'Failed to get community posts', details: error } as ErrorResponse);
    }
});

export default router;
