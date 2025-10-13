import { Router } from 'express';
import { AuthRequest } from '../../middlewares/authMiddleware';
import { ErrorResponse } from '../../models/interfaces/errorType';
import prisma from '../../prismaConnection';
import { CommentStatus, ReportType } from '@prisma/client';
import { IdShortener } from '../../services/IdShortener';
import { CommentService } from '../../services/CommentService';
import PaginationUtils from '../../utils/paginationUtils';

const router = Router();

// Create a comment
router.post('/create-comment', async (request: AuthRequest, response) => {
    const { community_id, post_id, content, is_anonymous, is_sponsored, parent_comment_id } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!community_id || !post_id || !content) {
        return response.status(400).json({ error: 'Community ID, post ID and content are required' } as ErrorResponse);
    }

    try {
        // Check if community exists
        const community = await prisma.community.findUnique({
            where: { id: community_id },
        });

        if (!community) {
            return response.status(400).json({ error: 'Community not found' } as ErrorResponse);
        }

        // Check if post exists
        const post = await prisma.post.findUnique({
            where: { id: post_id },
        });

        if (!post) {
            return response.status(400).json({ error: 'Post not found' } as ErrorResponse);
        }

        // Generate short ID
        const shortId = await IdShortener.generateCommentShortId();

        if (typeof shortId !== 'string') {
            return response.status(500).json(shortId as ErrorResponse);
        }

        const comment = await prisma.comment.create({
            data: {
                short_id: shortId,
                content,
                author_id: user.id,
                post_id,
                parent_comment_id,
                is_anonymous: is_anonymous || false,
                is_sponsored: is_sponsored || false,
            },
        });

        if (!comment) {
            return response.status(500).json({ error: 'Failed to create comment' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Comment created successfully', comment });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to create comment', details: error } as ErrorResponse);
    }
});

// Upvote a comment
router.post('/upvote', async (request: AuthRequest, response) => {
    const { comment_id } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!comment_id) {
        return response.status(400).json({ error: 'Comment ID is required' } as ErrorResponse);
    }

    try {
        // Check if already upvoted
        const isUpvoted = await prisma.comment.findFirst({
            where: { id: comment_id, upvoters: { some: { id: user.id } } },
        });

        if (isUpvoted) {
            return response.status(200).json({ error: 'Comment already upvoted' } as ErrorResponse);
        }

        // Check if comment is downvoted
        const isDownvoted = await prisma.comment.findFirst({
            where: { id: comment_id, downvoters: { some: { id: user.id } } },
        });

        if (isDownvoted) {
            // Remove downvote if it exists
            const isDownvoteRemoved = await prisma.comment.update({
                where: { id: comment_id },
                data: { downvoters: { disconnect: { id: user.id } } },
            });

            if (!isDownvoteRemoved) {
                return response.status(200).json({ error: 'Exisiting downvote unable to be removed' } as ErrorResponse);
            }
        }

        const comment = await prisma.comment.update({
            where: { id: comment_id },
            data: { upvoters: { connect: { id: user.id } } },
            select: {
                _count: {
                    select: {
                        upvoters: true,
                        downvoters: true,
                    },
                },
            },
        });

        if (!comment) {
            return response.status(500).json({ error: 'Failed to upvote comment' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Comment upvoted successfully', comment });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to upvote comment', details: error } as ErrorResponse);
    }
});

// Remove upvote from a comment
router.post('/remove-upvote', async (request: AuthRequest, response) => {
    const { comment_id } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!comment_id) {
        return response.status(400).json({ error: 'Comment ID is required' } as ErrorResponse);
    }

    try {
        // Check if upvote is already removed
        const isUpvotedAlreadyRemoved = await prisma.comment.findUnique({
            where: { id: comment_id, upvoters: { none: { id: user.id } } },
        });

        if (isUpvotedAlreadyRemoved) {
            return response.status(200).json({ error: 'No upvote to be removed' } as ErrorResponse);
        }

        const comment = await prisma.comment.update({
            where: { id: comment_id },
            data: { upvoters: { disconnect: { id: user.id } } },
            select: {
                _count: {
                    select: {
                        upvoters: true,
                        downvoters: true,
                    },
                },
            },
        });

        if (!comment) {
            return response.status(500).json({ error: 'Failed to remove upvote from comment' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Upvote removed from comment successfully', comment });
    } catch (error) {
        return response
            .status(500)
            .json({ error: 'Failed to remove upvote from comment', details: error } as ErrorResponse);
    }
});

// Downvote a comment
router.post('/downvote', async (request: AuthRequest, response) => {
    const { comment_id } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!comment_id) {
        return response.status(400).json({ error: 'Comment ID is required' } as ErrorResponse);
    }

    try {
        // Check if already downvoted
        const isDownvoted = await prisma.comment.findFirst({
            where: { id: comment_id, downvoters: { some: { id: user.id } } },
        });

        if (isDownvoted) {
            return response.status(200).json({ error: 'Comment already downvoted' } as ErrorResponse);
        }

        // Check if comment is upvoted
        const isUpvoted = await prisma.comment.findFirst({
            where: { id: comment_id, upvoters: { some: { id: user.id } } },
        });

        if (isUpvoted) {
            // Remove upvote if it exists
            const isUpvoteRemoved = await prisma.comment.update({
                where: { id: comment_id },
                data: { upvoters: { disconnect: { id: user.id } } },
                select: {
                    _count: {
                        select: {
                            upvoters: true,
                            downvoters: true,
                        },
                    },
                },
            });

            if (!isUpvoteRemoved) {
                return response.status(200).json({ error: 'Exisiting upvote unable to be removed' } as ErrorResponse);
            }
        }

        const comment = await prisma.comment.update({
            where: { id: comment_id },
            data: { downvoters: { connect: { id: user.id } } },
            select: {
                _count: {
                    select: {
                        upvoters: true,
                        downvoters: true,
                    },
                },
            },
        });

        if (!comment) {
            return response.status(500).json({ error: 'Failed to downvote comment' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Comment downvoted successfully', comment });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to downvote comment', details: error } as ErrorResponse);
    }
});

// Remove downvote from a comment
router.post('/remove-downvote', async (request: AuthRequest, response) => {
    const { comment_id } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!comment_id) {
        return response.status(400).json({ error: 'Comment ID is required' } as ErrorResponse);
    }

    try {
        // Check if upvote is already removed
        const isDownvotedAlreadyRemoved = await prisma.comment.findUnique({
            where: { id: comment_id, downvoters: { none: { id: user.id } } },
        });

        if (isDownvotedAlreadyRemoved) {
            return response.status(200).json({ error: 'No downvote to be removed' } as ErrorResponse);
        }

        const comment = await prisma.comment.update({
            where: { id: comment_id },
            data: { downvoters: { disconnect: { id: user.id } } },
            select: {
                _count: {
                    select: {
                        upvoters: true,
                        downvoters: true,
                    },
                },
            },
        });

        if (!comment) {
            return response.status(500).json({ error: 'Failed to remove downvote from comment' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Downvote removed from comment successfully', comment });
    } catch (error) {
        return response
            .status(500)
            .json({ error: 'Failed to remove downvote from comment', details: error } as ErrorResponse);
    }
});

// Edit a comment
router.post('/edit-comment', async (request: AuthRequest, response) => {
    const { comment_id, content } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!comment_id || !content) {
        return response.status(400).json({ error: 'Comment ID and content are required' } as ErrorResponse);
    }

    try {
        const comment = await prisma.comment.update({
            where: { id: comment_id },
            data: { content, is_edited: true, edited_at: new Date() },
        });

        if (!comment) {
            return response.status(500).json({ error: 'Failed to edit comment' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Comment edited successfully', comment });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to edit comment', details: error } as ErrorResponse);
    }
});

// Delete a comment
router.post('/delete-comment', async (request: AuthRequest, response) => {
    const { comment_id } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!comment_id) {
        return response.status(400).json({ error: 'Comment ID is required' } as ErrorResponse);
    }

    try {
        const comment = await prisma.comment.update({
            where: { id: comment_id },
            data: { status: CommentStatus.deleted, is_deleted: true, deleted_at: new Date() },
        });

        if (!comment) {
            return response.status(500).json({ error: 'Failed to delete comment' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Comment deleted successfully', comment });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to delete comment', details: error } as ErrorResponse);
    }
});

// Pin a comment
router.post('/pin-comment', async (request: AuthRequest, response) => {
    const { community_id, moderator_id, post_id, comment_id, reason } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!comment_id) {
        return response.status(400).json({ error: 'Comment ID is required' } as ErrorResponse);
    }

    try {
        const community = await prisma.community.findUnique({
            where: { id: community_id },
            include: {
                moderators: true,
            },
        });

        const moderators = community?.moderators.filter((moderator) => moderator.id === moderator_id);

        if (!moderators) {
            return response.status(400).json({ error: 'Moderator not found' } as ErrorResponse);
        } else if (moderators.length < 1) {
            return response.status(400).json({ error: 'Moderator is not a member of the community' } as ErrorResponse);
        }

        const post = await prisma.post.update({
            where: { id: post_id },
            data: {
                pinned_comment_id: comment_id,
                pinned_comment_reason: reason,
                pinned_comment_at: new Date(),
                pinned_comment_by: moderators[0].id,
            },
        });

        if (!post) {
            return response.status(500).json({ error: 'Failed to pin comment' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Comment pinned successfully', post });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to pin comment', details: error } as ErrorResponse);
    }
});

// Unpin a comment
router.post('/unpin-comment', async (request: AuthRequest, response) => {
    const { community_id, moderator_id, post_id } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!post_id) {
        return response.status(400).json({ error: 'Post ID is required' } as ErrorResponse);
    }

    try {
        const community = await prisma.community.findUnique({
            where: { id: community_id },
            include: {
                moderators: true,
            },
        });

        const moderators = community?.moderators.filter((moderator) => moderator.id === moderator_id);

        if (!moderators) {
            return response.status(400).json({ error: 'Moderator not found' } as ErrorResponse);
        } else if (moderators.length < 1) {
            return response.status(400).json({ error: 'Moderator is not a member of the community' } as ErrorResponse);
        }

        const post = await prisma.post.update({
            where: { id: post_id },
            data: {
                pinned_comment_id: null,
                pinned_comment_reason: null,
                pinned_comment_at: null,
                pinned_comment_by: null,
            },
        });

        if (!post) {
            return response.status(500).json({ error: 'Failed to unpin comment' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Comment unpinned successfully', post });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to unpin comment', details: error } as ErrorResponse);
    }
});

// Remove a comment
router.post('/remove-comment', async (request: AuthRequest, response) => {
    const { community_id, moderator_id, post_id, comment_id, reason } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!comment_id || !post_id || !community_id || !moderator_id || !reason) {
        return response.status(400).json({
            error: 'Comment ID, post ID, community ID, moderator ID and reason are required',
        } as ErrorResponse);
    }

    try {
        const community = await prisma.community.findUnique({
            where: { id: community_id },
            include: {
                moderators: true,
            },
        });

        const moderators = community?.moderators.filter((moderator) => moderator.id === moderator_id);

        if (!moderators) {
            return response.status(400).json({ error: 'Moderator not found' } as ErrorResponse);
        } else if (moderators.length < 1) {
            return response.status(400).json({ error: 'Moderator is not a member of the community' } as ErrorResponse);
        }

        const comment = await prisma.comment.update({
            where: { id: comment_id },
            data: {
                status: CommentStatus.removed,
                is_removed: true,
                removed_at: new Date(),
                removed_by: moderators[0].id,
                removed_reason: reason,
            },
        });

        if (!comment) {
            return response.status(500).json({ error: 'Failed to remove comment' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Comment removed successfully', comment });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to remove comment', details: error } as ErrorResponse);
    }
});

// Hide a comment
router.post('/hide-comment', async (request: AuthRequest, response) => {
    const { community_id, moderator_id, post_id, comment_id, reason } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!comment_id || !post_id || !community_id || !moderator_id || !reason) {
        return response.status(400).json({
            error: 'Comment ID, post ID, community ID, moderator ID and reason are required',
        } as ErrorResponse);
    }

    if (!comment_id) {
        return response.status(400).json({ error: 'Comment ID is required' } as ErrorResponse);
    }

    try {
        const community = await prisma.community.findUnique({
            where: { id: community_id },
            include: {
                moderators: true,
            },
        });

        const moderators = community?.moderators.filter((moderator) => moderator.id === moderator_id);

        if (!moderators) {
            return response.status(400).json({ error: 'Moderator not found' } as ErrorResponse);
        } else if (moderators.length < 1) {
            return response.status(400).json({ error: 'Moderator is not a member of the community' } as ErrorResponse);
        }

        const comment = await prisma.comment.update({
            where: { id: comment_id },
            data: {
                status: CommentStatus.hidden,
                is_hidden: true,
                hidden_at: new Date(),
                hidden_by: moderators[0].id,
                hidden_reason: reason,
            },
        });

        if (!comment) {
            return response.status(500).json({ error: 'Failed to hide comment' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Comment hidden successfully', comment });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to hide comment', details: error } as ErrorResponse);
    }
});

// Unhide a comment
router.post('/unhide-comment', async (request: AuthRequest, response) => {
    const { community_id, moderator_id, post_id, comment_id } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!comment_id || !post_id || !community_id || !moderator_id) {
        return response.status(400).json({
            error: 'Comment ID, post ID, community ID, and moderator ID are required',
        } as ErrorResponse);
    }

    if (!comment_id) {
        return response.status(400).json({ error: 'Comment ID is required' } as ErrorResponse);
    }

    try {
        const community = await prisma.community.findUnique({
            where: { id: community_id },
            include: {
                moderators: true,
            },
        });

        const moderators = community?.moderators.filter((moderator) => moderator.id === moderator_id);

        if (!moderators) {
            return response.status(400).json({ error: 'Moderator not found' } as ErrorResponse);
        } else if (moderators.length < 1) {
            return response.status(400).json({ error: 'Moderator is not a member of the community' } as ErrorResponse);
        }

        const comment = await prisma.comment.update({
            where: { id: comment_id },
            data: {
                status: CommentStatus.active,
                is_hidden: false,
                hidden_at: null,
                hidden_by: null,
                hidden_reason: null,
            },
        });

        if (!comment) {
            return response.status(500).json({ error: 'Failed to unhide comment' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Comment unhidden successfully', comment });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to unhide comment', details: error } as ErrorResponse);
    }
});

// Report a comment
router.post('/report-comment', async (request: AuthRequest, response) => {
    const { post_id, comment_id, reason } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }
    if (!comment_id || !post_id || !reason) {
        return response.status(400).json({
            error: 'Comment ID, post ID, community ID, moderator ID and reason are required',
        } as ErrorResponse);
    }

    try {
        const comment = await prisma.comment.findUnique({
            where: { id: comment_id },
        });

        if (!comment) {
            return response.status(400).json({ error: 'Comment not found' } as ErrorResponse);
        }

        const community = await prisma.report.create({
            data: {
                reporter_id: user.id,
                reported_id: comment.author_id,
                report_type: ReportType.comment,
                report_message: reason,
                comment_id,
            },
        });

        if (!community) {
            return response.status(500).json({ error: 'Failed to report comment' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Comment reported successfully', community });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to report comment', details: error } as ErrorResponse);
    }
});

// Save a comment
router.post('/save-comment', async (request: AuthRequest, response) => {
    const { comment_id } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!comment_id) {
        return response.status(400).json({ error: 'Comment ID is required' } as ErrorResponse);
    }

    try {
        // Check if comment exists
        const comment = await prisma.comment.findUnique({
            where: { id: comment_id },
        });

        if (!comment) {
            return response.status(400).json({ error: 'Comment not found' } as ErrorResponse);
        }

        // Check if comment is already saved by the user
        const existingSave = await prisma.user.findFirst({
            where: {
                id: user.id,
                saved_comments: {
                    some: {
                        id: comment_id,
                    },
                },
            },
        });

        if (existingSave) {
            return response.status(400).json({ error: 'Comment already saved' } as ErrorResponse);
        }

        // Add comment to user's saved comments
        await prisma.user.update({
            where: { id: user.id },
            data: {
                saved_comments: {
                    connect: { id: comment_id },
                },
            },
        });

        return response.status(200).json({ message: 'Comment saved successfully' });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to save comment', details: error } as ErrorResponse);
    }
});

// Unsave a comment
router.post('/unsave-comment', async (request: AuthRequest, response) => {
    const { comment_id } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!comment_id) {
        return response.status(400).json({ error: 'Comment ID is required' } as ErrorResponse);
    }

    try {
        // Check if comment exists
        const comment = await prisma.comment.findUnique({
            where: { id: comment_id },
        });

        if (!comment) {
            return response.status(400).json({ error: 'Comment not found' } as ErrorResponse);
        }

        // Check if comment is saved by the user
        const existingSave = await prisma.user.findFirst({
            where: {
                id: user.id,
                saved_comments: {
                    some: {
                        id: comment_id,
                    },
                },
            },
        });

        if (!existingSave) {
            return response.status(400).json({ error: 'Comment not saved by user' } as ErrorResponse);
        }

        // Remove comment from user's saved comments
        await prisma.user.update({
            where: { id: user.id },
            data: {
                saved_comments: {
                    disconnect: { id: comment_id },
                },
            },
        });

        return response.status(200).json({ message: 'Comment unsaved successfully' });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to unsave comment', details: error } as ErrorResponse);
    }
});

// Get user's saved comments
router.get('/saved-comments', async (request: AuthRequest, response) => {
    const user = request.user;
    const {
        page = CommentService.DEFAULT_PAGE_NUMBER,
        limit = CommentService.DEFAULT_LIMIT,
        sort_by = CommentService.DEFAULT_SORT_BY,
    } = request.query;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    const { pageNumber, limitNumber, offset } = PaginationUtils.calculatePaginationDetails('comment', page, limit);

    try {
        const savedComments = await prisma.user.findUnique({
            where: { id: user.id },
            select: {
                saved_comments: {
                    where: {
                        status: {
                            not: CommentStatus.deleted,
                        },
                    },
                    take: limitNumber,
                    skip: offset,
                    orderBy: CommentService.getSortOrder(sort_by as string) as any,
                    include: {
                        author_ref: {
                            select: {
                                id: true,
                                username: true,
                                display_name: true,
                                avatar_id: true,
                            },
                        },
                        post_ref: {
                            select: {
                                id: true,
                                title: true,
                                slug: true,
                                community_ref: {
                                    select: {
                                        id: true,
                                        name: true,
                                    },
                                },
                            },
                        },
                        _count: {
                            select: {
                                upvoters: true,
                                downvoters: true,
                                child_comments: true,
                            },
                        },
                    },
                },
            },
        });

        if (!savedComments) {
            return response.status(400).json({ error: 'User not found' } as ErrorResponse);
        }

        const totalSavedComments = await prisma.user.count({
            where: {
                id: user.id,
                saved_comments: {
                    some: {
                        status: {
                            not: CommentStatus.deleted,
                        },
                    },
                },
            },
        });

        const totalPages = Math.ceil(totalSavedComments / limitNumber);

        return response.status(200).json({
            message: 'Saved comments retrieved successfully',
            saved_comments: savedComments?.saved_comments || [],
            pagination: PaginationUtils.preparePaginationResponse(pageNumber, totalPages, totalSavedComments),
        });
    } catch (error) {
        return response
            .status(500)
            .json({ error: 'Failed to retrieve saved comments', details: error } as ErrorResponse);
    }
});

// Check if a comment is saved by the user
router.get('/check-saved-status/:comment_id', async (request: AuthRequest, response) => {
    const { comment_id } = request.params;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!comment_id) {
        return response.status(400).json({ error: 'Comment ID is required' } as ErrorResponse);
    }

    try {
        // Check if comment exists
        const comment = await prisma.comment.findUnique({
            where: { id: comment_id },
        });

        if (!comment) {
            return response.status(400).json({ error: 'Comment not found' } as ErrorResponse);
        }

        // Check if comment is saved by the user
        const isSaved = await prisma.user.findFirst({
            where: {
                id: user.id,
                saved_comments: {
                    some: {
                        id: comment_id,
                    },
                },
            },
        });

        return response.status(200).json({
            message: 'Saved status checked successfully',
            is_saved: !!isSaved,
            comment_id: comment_id,
        });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to check saved status', details: error } as ErrorResponse);
    }
});

export default router;
