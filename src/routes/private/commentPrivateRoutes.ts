import { Router } from 'express';
import { AuthRequest } from '../../middlewares/authMiddleware';
import { ErrorResponse } from '../../models/interfaces/errorType';
import prisma from '../../prismaConnection';
import { CommentStatus, ReportType } from '@prisma/client';
import { IdShortener } from '../../services/IdShortener';

const router = Router();

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

export default router;
