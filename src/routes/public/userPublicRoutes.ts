import { Router } from 'express';
import prisma from '../../prismaConnection';
import { AuthRequest } from '../../middlewares/authMiddleware';
import { CommentService } from '../../services/CommentService';
import { PostService } from '../../services/PostService';
import PaginationUtils from '../../utils/paginationUtils';
import { ErrorResponse } from '../../models/interfaces/errorType';
import { AVATAR_OPTIONS } from '../../models/interfaces/avatar';

const router = Router();

router.get('/:username', async (request, response) => {
    const { username } = request.params;

    if (!username) {
        return response.status(400).json({ error: 'Username is required' });
    }

    try {
        const user = await prisma.user.findUnique({
            where: { username: username.toLowerCase() },
            select: {
                created_at: true,
                username: true,
                display_name: true,
                avatar_id: true,
                account_status: true,
                user_type: true,
                is_email_verified: true,
            },
        });

        if (!user) {
            return response.status(404).json({ error: 'User not found' });
        }

        return response.status(200).json({ user });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to get user', details: error });
    }
});

router.get('/:username/posts', async (request: AuthRequest, response) => {
    const user = request.user;
    const { username } = request.params;
    const {
        page = CommentService.DEFAULT_PAGE_NUMBER,
        limit = CommentService.DEFAULT_LIMIT,
        sort_by = CommentService.DEFAULT_SORT_BY,
    } = request.query;

    if (!username) {
        return response.status(400).json({ error: 'Username is required' });
    }

    const { pageNumber, limitNumber, offset } = PaginationUtils.calculatePaginationDetails('post', page, limit);

    try {
        const user = await prisma.user.findUnique({
            where: { username: username.toLowerCase() },
            include: {
                posts: {
                    take: limitNumber,
                    skip: offset,
                    orderBy: PostService.getSortOrder(sort_by as string) as any,
                    include: {
                        author_ref: { select: { username: true, avatar_id: true } },
                        _count: { select: { comments: true, upvoters: true, downvoters: true } },
                    },
                },
            },
        });

        if (!user) {
            return response.status(404).json({ error: 'User posts not found' });
        }

        const totalPosts = await prisma.post.count({
            where: { author_id: user.id },
        });

        const totalPages = Math.ceil(totalPosts / limitNumber);

        return response.status(200).json({
            posts: user.posts,
            pagination: PaginationUtils.preparePaginationResponse(pageNumber, totalPages, totalPosts),
        });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to get user posts', details: error } as ErrorResponse);
    }
});

export default router;
