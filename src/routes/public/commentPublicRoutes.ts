import { Router } from 'express';
import { CommentService } from '../../services/CommentService';
import prisma from '../../prismaConnection';
import { CommentPaginationResponse } from './postPublicRoutes';
const router = Router();

// Get comment
// Get a child comments
router.get('/:community_name/replies/:post_short_id/reply/:comment_short_id', async (request, response) => {
    const { post_short_id, comment_short_id } = request.params;
    const {
        sort_by = CommentService.DEFAULT_SORT_BY,
        parent_page_number = CommentService.DEFAULT_PAGE_NUMBER,
        parent_limit = CommentService.DEFAULT_LIMIT,
    } = request.query;

    const pageNumber = Math.max(1, parseInt(parent_page_number as string) || CommentService.DEFAULT_PAGE_NUMBER);
    const limitNumber = Math.min(Math.max(1, parseInt(parent_limit as string) || CommentService.DEFAULT_LIMIT), 100);
    const offset = (pageNumber - 1) * limitNumber;

    const comments = await prisma.comment.findMany({
        where: { short_id: comment_short_id },
        take: limitNumber,
        skip: offset,
        orderBy: CommentService.getSortOrder(sort_by as string) as any,
        include: {
            author_ref: { select: { username: true, avatar_id: true } },
            _count: { select: { child_comments: true, upvoters: true, downvoters: true } },
        },
    });

    if (!comments) {
        return response.status(404).json({ error: 'Comments not found' });
    }

    const totalComments = await prisma.comment.count({
        where: { parent_comment_id: comment_short_id },
    });

    const totalPages = Math.ceil(totalComments / limitNumber);

    response.json({
        comments,
        pagination: {
            parent: {
                current_page: pageNumber,
                total_pages: totalPages,
                total_comments: totalComments,
                has_next_page: pageNumber < totalPages,
                has_previous_page: pageNumber > 1,
                next_page: pageNumber < totalPages ? pageNumber + 1 : null,
                previous_page: pageNumber > 1 ? pageNumber - 1 : null,
            },
        } as CommentPaginationResponse,
    });
});

export default router;
