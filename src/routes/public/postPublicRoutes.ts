import { Router } from 'express';
import prisma from '../../prismaConnection';
import { PasswordService } from '../../services/PasswordService';
import { IdShortener } from '../../services/IdShortener';
import { ErrorResponse } from '../../models/interfaces/errorType';
import { PostService } from '../../services/PostService';
import { CommentService } from '../../services/CommentService';
import PaginationUtils from '../../utils/paginationUtils';

const router = Router();

// Get a post by short_id
// router.get('/:community_name/replies/:short_id', async (request, response) => {
//     const { short_id } = request.params;

//     try {
//         const post = await prisma.post.findUnique({
//             where: { short_id },
//         });

//         if (!post) {
//             return response.status(404).json({ error: 'Post not found' });
//         }

//         response.json({ post });
//     } catch (error) {
//         response.status(500).json({ error: 'Failed to get post', details: error } as ErrorResponse);
//     }
// });

// Get a post by slug
// router.get('/:community_name/replies/:short_id/:slug', async (request, response) => {
//     const { short_id, slug } = request.params;

//     try {
//         const post = await prisma.post.findUnique({
//             where: { short_id },
//         });

//         if (!post) {
//             return response.status(404).json({ error: 'Post not found' });
//         }

//         response.json({ post });
//     } catch (error) {
//         response.status(500).json({ error: 'Failed to get post', details: error } as ErrorResponse);
//     }
// });

// Get comments for a post
router.get('/:community_name/replies/:post_short_id', async (request, response) => {
    const { post_short_id } = request.params;
    const {
        sort_by = CommentService.DEFAULT_SORT_BY,
        parent_page_number = CommentService.DEFAULT_PAGE_NUMBER,
        child_page_number = CommentService.DEFAULT_REPLY_PAGE_NUMBER,
        parent_limit = CommentService.DEFAULT_LIMIT,
        child_limit = CommentService.DEFAULT_REPLY_LIMIT,
    } = request.query;

    try {
        const { pageNumber, limitNumber, offset } = PaginationUtils.calculatePaginationDetails(
            'post',
            parent_page_number,
            parent_limit
        );
        const {
            pageNumber: childPageNumber,
            limitNumber: childLimitNumber,
            offset: childOffset,
        } = PaginationUtils.calculatePaginationDetails('post', child_page_number, child_limit);

        const post = await prisma.post.findUnique({
            where: { short_id: post_short_id },
        });
        if (!post) {
            return response.status(404).json({ error: 'Post not found' });
        }

        const comments = await prisma.comment.findMany({
            where: { post_id: post.id, parent_comment_id: null },
            take: limitNumber,
            skip: offset,
            orderBy: CommentService.getSortOrder(sort_by as string) as any,
            include: {
                author_ref: { select: { username: true, avatar_id: true } },
                child_comments: {
                    take: childLimitNumber,
                    skip: childOffset,
                    include: {
                        author_ref: { select: { username: true, avatar_id: true } },
                    },
                },
                _count: { select: { child_comments: true, upvoters: true, downvoters: true } },
            },
        });

        if (!comments) {
            return response.status(404).json({ error: 'Comments not found' });
        }

        const totalComments = await prisma.comment.count({
            where: { post_id: post.id, parent_comment_id: null },
        });

        const totalPages = Math.ceil(totalComments / limitNumber);

        response.json({
            comments,
            pagination: PaginationUtils.preparePaginationResponse(pageNumber, totalPages, totalComments),
        });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to get comments', details: error } as ErrorResponse);
    }
});

export default router;
