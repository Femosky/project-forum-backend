import { Router } from 'express';
import prisma from '../../prismaConnection';
import { PasswordService } from '../services/PasswordService';
import { IdShortener } from '../services/IdShortener';
import { ErrorResponse } from '../../models/interfaces/errorType';
import { PostService } from '../services/PostService';
import { CommentService } from '../services/CommentService';

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

interface CommentPaginationResponse {
    current_page: number;
    total_pages: number;
    total_comments: number;
    has_next_page: boolean;
    has_previous_page: boolean;
    next_page: number;
    previous_page: number;
}

interface CommentPaginationResponse {
    parent: CommentPaginationResponse;
    child?: CommentPaginationResponse;
}

// Get comments for a post
router.get('/:community_name/replies/:short_id/:slug', async (request, response) => {
    const { short_id } = request.params;
    const {
        sort_by = CommentService.DEFAULT_SORT_BY,
        parent_page_number = CommentService.DEFAULT_PAGE_NUMBER,
        child_page_number = CommentService.DEFAULT_REPLY_PAGE_NUMBER,
        parent_limit = CommentService.DEFAULT_LIMIT,
        child_limit = CommentService.DEFAULT_REPLY_LIMIT,
    } = request.query;

    try {
        const pageNumber = Math.max(1, parseInt(parent_page_number as string) || CommentService.DEFAULT_PAGE_NUMBER);
        const limitNumber = Math.min(
            Math.max(1, parseInt(parent_limit as string) || CommentService.DEFAULT_LIMIT),
            100
        );

        const childPageNumber = Math.max(
            1,
            parseInt(child_page_number as string) || CommentService.DEFAULT_REPLY_PAGE_NUMBER
        );
        const childLimitNumber = Math.min(
            Math.max(1, parseInt(child_limit as string) || CommentService.DEFAULT_REPLY_LIMIT),
            50
        );

        const offset = (pageNumber - 1) * limitNumber;
        const childOffset = (childPageNumber - 1) * childLimitNumber;

        const post = await prisma.post.findUnique({
            where: { short_id },
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

        const totalParentComments = await prisma.comment.count({
            where: { post_id: post.id, parent_comment_id: null },
        });
        const totalChildComments = await prisma.comment.count({
            where: { post_id: post.id, parent_comment_id: { not: null } },
        });

        const totalParentPages = Math.ceil(totalParentComments / limitNumber);
        const totalChildPages = Math.ceil(totalChildComments / childLimitNumber);

        response.json({
            comments,
            pagination: {
                parent: {
                    current_page: pageNumber,
                    total_pages: totalParentPages,
                    total_comments: totalParentComments,
                    has_next_page: pageNumber < totalParentPages,
                    has_previous_page: pageNumber > 1,
                    next_page: pageNumber < totalParentPages ? pageNumber + 1 : null,
                    previous_page: pageNumber > 1 ? pageNumber - 1 : null,
                },
                child: {
                    current_page: childPageNumber,
                    total_pages: totalChildPages,
                    total_comments: totalChildComments,
                    has_next_page: childPageNumber < totalChildPages,
                    has_previous_page: childPageNumber > 1,
                    next_page: childPageNumber < totalChildPages ? childPageNumber + 1 : null,
                    previous_page: childPageNumber > 1 ? childPageNumber - 1 : null,
                },
            } as CommentPaginationResponse,
        });
    } catch (error) {}
});

// Get a child comments
router.get('/:community_name/replies/:short_id/:slug/:comment_id', async (request, response) => {
    const { short_id, slug, comment_id } = request.params;
    const {
        sort_by = CommentService.DEFAULT_SORT_BY,
        parent_page_number = CommentService.DEFAULT_PAGE_NUMBER,
        parent_limit = CommentService.DEFAULT_LIMIT,
    } = request.query;

    const pageNumber = Math.max(1, parseInt(parent_page_number as string) || CommentService.DEFAULT_PAGE_NUMBER);
    const limitNumber = Math.min(Math.max(1, parseInt(parent_limit as string) || CommentService.DEFAULT_LIMIT), 100);
    const offset = (pageNumber - 1) * limitNumber;

    const comments = await prisma.comment.findMany({
        where: { parent_comment_id: comment_id },
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
        where: { parent_comment_id: comment_id },
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
