import { Router } from 'express';
import { AuthRequest } from '../../middlewares/authMiddleware';
import { ErrorResponse } from '../../models/interfaces/errorType';
import prisma from '../../prismaConnection';
import { PostStatus } from '@prisma/client';
import { IdShortener } from '../../services/IdShortener';
import { SlugGenerator } from '../../services/SlugGenerator';

const router = Router();

// Posts

router.post('/create-post', async (request: AuthRequest, response) => {
    const { community_id, title, content, is_anonymous, is_sponsored, tags, ai_summary } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!community_id || !title || !content) {
        return response.status(400).json({ error: 'Community ID, title and content are required' } as ErrorResponse);
    }

    try {
        // Check if community exists
        const community = await prisma.community.findUnique({
            where: { id: community_id },
        });

        if (!community) {
            throw new Error('Community not found');
        }

        // Generate short ID
        const shortId = await IdShortener.generatePostShortId();

        if (typeof shortId !== 'string') {
            throw new Error(shortId.error);
        }

        // Generate slug
        const slug = await SlugGenerator.generateSlug(title);
        console.log('shortId', shortId);

        // Create post (Prisma create throws on failure; it never returns null)
        await prisma.post.create({
            data: {
                short_id: shortId,
                title,
                content,
                is_anonymous: is_anonymous || false,
                is_sponsored: is_sponsored || false,
                tags: Array.isArray(tags) ? tags : [],
                slug,
                ai_summary: ai_summary ?? null,
                author_id: user.id,
                community_id,
            },
        });

        return response.status(200).json({ message: 'Post created successfully' });
    } catch (error) {
        console.error('Create post failed:', error);
        return response.status(500).json({ error: 'Failed to create post', details: error } as ErrorResponse);
    }
});

// Upvote a post
router.post('/upvote', async (request: AuthRequest, response) => {
    const { post_id } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!post_id) {
        return response.status(400).json({ error: 'Post ID is required' } as ErrorResponse);
    }

    try {
        // Check if already upvoted
        const isUpvoted = await prisma.post.findFirst({
            where: { id: post_id, upvoters: { some: { id: user.id } } },
        });

        if (isUpvoted) {
            return response.status(200).json({ error: 'Post already upvoted' } as ErrorResponse);
        }

        // Check if post is downvoted
        const isDownvoted = await prisma.post.findFirst({
            where: { id: post_id, downvoters: { some: { id: user.id } } },
        });

        if (isDownvoted) {
            // Remove downvote if it exists
            const isDownvoteRemoved = await prisma.post.update({
                where: { id: post_id },
                data: { downvoters: { disconnect: { id: user.id } } },
            });

            if (!isDownvoteRemoved) {
                return response.status(200).json({ error: 'Exisiting downvote unable to be removed' } as ErrorResponse);
            }
        }

        const post = await prisma.post.update({
            where: { id: post_id },
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

        if (!post) {
            return response.status(500).json({ error: 'Failed to upvote post' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Post upvoted successfully', post });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to upvote post', details: error } as ErrorResponse);
    }
});

// Remove upvote from a post
router.post('/remove-upvote', async (request: AuthRequest, response) => {
    const { post_id } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!post_id) {
        return response.status(400).json({ error: 'Post ID is required' } as ErrorResponse);
    }

    try {
        // Check if upvote is already removed
        const isUpvotedAlreadyRemoved = await prisma.post.findUnique({
            where: { id: post_id, upvoters: { none: { id: user.id } } },
        });

        if (isUpvotedAlreadyRemoved) {
            return response.status(200).json({ error: 'No upvote to be removed' } as ErrorResponse);
        }

        const post = await prisma.post.update({
            where: { id: post_id },
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

        if (!post) {
            return response.status(500).json({ error: 'Failed to remove upvote from post' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Upvote removed from post successfully', post });
    } catch (error) {
        return response
            .status(500)
            .json({ error: 'Failed to remove upvote from post', details: error } as ErrorResponse);
    }
});

// Downvote a post
router.post('/downvote', async (request: AuthRequest, response) => {
    const { post_id } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!post_id) {
        return response.status(400).json({ error: 'Post ID is required' } as ErrorResponse);
    }

    try {
        // Check if already downvoted
        const isDownvoted = await prisma.post.findFirst({
            where: { id: post_id, downvoters: { some: { id: user.id } } },
        });

        if (isDownvoted) {
            return response.status(200).json({ error: 'Post already downvoted' } as ErrorResponse);
        }

        // Check if post is upvoted
        const isUpvoted = await prisma.post.findFirst({
            where: { id: post_id, upvoters: { some: { id: user.id } } },
        });

        if (isUpvoted) {
            // Remove upvote if it exists
            const isUpvoteRemoved = await prisma.post.update({
                where: { id: post_id },
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

        const post = await prisma.post.update({
            where: { id: post_id },
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

        if (!post) {
            return response.status(500).json({ error: 'Failed to downvote post' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Post downvoted successfully', post });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to downvote post', details: error } as ErrorResponse);
    }
});

// Remove downvote from a post
router.post('/remove-downvote', async (request: AuthRequest, response) => {
    const { post_id } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!post_id) {
        return response.status(400).json({ error: 'Post ID is required' } as ErrorResponse);
    }

    try {
        // Check if upvote is already removed
        const isDownvotedAlreadyRemoved = await prisma.post.findUnique({
            where: { id: post_id, downvoters: { none: { id: user.id } } },
        });

        if (isDownvotedAlreadyRemoved) {
            return response.status(200).json({ error: 'No downvote to be removed' } as ErrorResponse);
        }

        const post = await prisma.post.update({
            where: { id: post_id },
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

        if (!post) {
            return response.status(500).json({ error: 'Failed to remove downvote from post' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Downvote removed from post successfully', post });
    } catch (error) {
        return response
            .status(500)
            .json({ error: 'Failed to remove downvote from post', details: error } as ErrorResponse);
    }
});

router.post('remove-post', async (request: AuthRequest, response) => {
    const { community_id, postId, removed_reason } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!community_id || !postId) {
        return response.status(400).json({ error: 'Community ID and post ID are required' } as ErrorResponse);
    }

    try {
        // Check if community exists
        const community = await prisma.community.findUnique({
            where: { id: community_id },
        });

        if (!community) {
            return response.status(400).json({ error: 'Community not found' } as ErrorResponse);
        }

        // Check if user is a moderator of the community
        const isUserModerator = await prisma.community.findFirst({
            where: { id: community_id, moderators: { some: { user_id: user.id } } },
        });

        if (!isUserModerator) {
            return response.status(400).json({ error: 'User is not a moderator of the community' } as ErrorResponse);
        }

        const isPostExists = await prisma.post.findUnique({
            where: { id: postId },
        });

        if (!isPostExists) {
            return response.status(400).json({ error: 'Post not found' } as ErrorResponse);
        }

        // Remove post from community
        const isPostRemoved = await prisma.post.update({
            where: { id: postId },
            data: {
                status: PostStatus.removed,
                is_removed: true,
                removed_at: new Date(),
                removed_reason,
            },
        });

        if (!isPostRemoved) {
            return response.status(500).json({ error: 'Failed to remove post' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Post has been marked asremoved from community successfully' });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to remove post', details: error } as ErrorResponse);
    }
});

export default router;
