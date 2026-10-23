import { Router } from 'express';
import { CommentService } from '../../services/CommentService';
import prisma from '../../prismaConnection';
import PaginationUtils from '../../utils/paginationUtils';
import { toPublicComment, VISIBLE_COMMENT_STATUSES, VISIBLE_POST_STATUSES } from '../../utils/ContentSerializer';
const router = Router();

// Get comment
// Get child comments
router.get('/:community_name/replies/:post_short_id/reply/:comment_short_id', async (request, response) => {
    const { post_short_id, comment_short_id } = request.params;
    const {
        sort_by = CommentService.DEFAULT_SORT_BY,
        parent_page_number = CommentService.DEFAULT_PAGE_NUMBER,
        parent_limit = CommentService.DEFAULT_LIMIT,
    } = request.query;

    const { pageNumber, limitNumber, offset } = PaginationUtils.calculatePaginationDetails(
        'comment',
        parent_page_number,
        parent_limit
    );

    const parentComment = await prisma.comment.findUnique({
        where: { short_id: comment_short_id },
        include: { post_ref: { select: { short_id: true, status: true } } },
    });
    if (
        !parentComment ||
        !VISIBLE_COMMENT_STATUSES.includes(parentComment.status) ||
        parentComment.post_ref.short_id !== post_short_id ||
        !VISIBLE_POST_STATUSES.includes(parentComment.post_ref.status)
    ) {
        return response.status(404).json({ error: 'Parent comment not found' });
    }

    const comments = await prisma.comment.findMany({
        where: { parent_comment_id: parentComment.id, status: { in: VISIBLE_COMMENT_STATUSES } },
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
        where: { parent_comment_id: parentComment.id, status: { in: VISIBLE_COMMENT_STATUSES } },
    });

    const totalPages = Math.ceil(totalComments / limitNumber);

    response.json({
        comments: comments.map((comment) => toPublicComment(comment)),
        pagination: PaginationUtils.preparePaginationResponse(pageNumber, totalPages, totalComments),
    });
});

export default router;
