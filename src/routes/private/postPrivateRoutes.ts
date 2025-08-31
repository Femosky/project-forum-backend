import { Router } from 'express';
import { AuthRequest } from '../../middlewares/authMiddleware';
import { ErrorResponse } from '../../models/interfaces/errorType';
import prisma from '../../prismaConnection';
import { PostStatus } from '@prisma/client';
import { IdShortener } from '../../utils/IdShortener';
import { SlugGenerator } from '../../utils/SlugGenerator';

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
            return response.status(400).json({ error: 'Community not found' } as ErrorResponse);
        }

        // Generate short ID
        const shortId = await IdShortener.generateShortId();

        if (typeof shortId !== 'string') {
            return response.status(500).json(shortId as ErrorResponse);
        }

        // Generate slug
        const slug = await SlugGenerator.generateSlug(title);

        // Create post
        const isPostCreated = await prisma.post.create({
            data: {
                short_id: shortId,
                title,
                content,
                is_anonymous: is_anonymous || false,
                is_sponsored: is_sponsored || false,
                tags: tags || [],
                slug,
                ai_summary,
                author: user.id,
                community_id,
            },
        });

        if (!isPostCreated) {
            return response.status(500).json({ error: 'Failed to create post' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Post created successfully' });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to create post', details: error } as ErrorResponse);
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
