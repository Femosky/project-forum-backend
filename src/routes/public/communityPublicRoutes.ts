import { Router } from 'express';
import prisma from '../../prismaConnection';
import { ErrorResponse } from '../../models/interfaces/errorType';
import PaginationUtils from '../../utils/paginationUtils';
import { toPublicPost, VISIBLE_POST_STATUSES } from '../../utils/ContentSerializer';
import { PostService } from '../../services/PostService';
import { sendServerError } from '../../utils/errorUtils';

const router = Router();

/*
    Community routes as /community
    - Get a community by name
    - Get posts for a community with pagination
*/

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
        return sendServerError(response, 'Failed to get community', error);
    }
});

// Get posts for a community with pagination

router.get('/:community_name/posts', async (request, response) => {
    const { community_name } = request.params;
    const {
        page = PostService.DEFAULT_PAGE_NUMBER,
        limit = PostService.DEFAULT_LIMIT,
        sort_by = PostService.DEFAULT_SORT_BY,
    } = request.query;

    try {
        const community = await prisma.community.findUnique({
            where: { name: community_name.toLowerCase() },
        });
        if (!community) {
            return response.status(404).json({ error: 'Community not found with this name' });
        }

        const { pageNumber, limitNumber, offset } = PaginationUtils.calculatePaginationDetails('post', page, limit);

        const posts = await prisma.post.findMany({
            where: { community_id: community.id, status: { in: VISIBLE_POST_STATUSES } },
            take: limitNumber,
            skip: offset,
            orderBy: PostService.getSortOrder(sort_by as string) as any,
            include: {
                author_ref: {
                    select: { username: true, avatar_id: true },
                },
                community_ref: {
                    select: { name: true },
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
            where: { community_id: community.id, status: { in: VISIBLE_POST_STATUSES } },
        });

        const totalPages = Math.ceil(totalPosts / limitNumber);

        response.json({
            posts: posts.map((post) => toPublicPost(post)),
            pagination: PaginationUtils.preparePaginationResponse(pageNumber, totalPages, totalPosts),
        });
    } catch (error) {
        sendServerError(response, 'Failed to get community posts', error);
    }
});

export default router;
