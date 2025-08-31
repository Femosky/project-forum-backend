import { Router } from 'express';
import prisma from '../../prismaConnection';
import { PasswordService } from '../../utils/passwordService';
import { IdShortener } from '../../utils/IdShortener';

const router = Router();

// Get 10 random posts for a community
router.get('/:community_name/posts', async (request, response) => {
    const { community_name } = request.params;

    try {
        const community = await prisma.community.findUnique({
            where: { name: community_name },
        });
        if (!community) {
            return response.status(404).json({ error: 'Community not found' });
        }
        const posts = await prisma.post.findMany({
            where: { community_id: community.id },
            take: 10,
            orderBy: {
                created_at: 'desc',
            },
        });
        if (!posts) {
            return response.status(404).json({ error: 'Posts not found' });
        }
        response.json({
            posts,
            short_id: await IdShortener.generateShortId(),
        });
    } catch (error) {}
});

// Get a post by short_id
router.get('/:community_name/replies/:short_id', async (request, response) => {
    const { short_id } = request.params;

    try {
        const post = await prisma.post.findUnique({
            where: { short_id },
        });

        if (!post) {
            return response.status(404).json({ error: 'Post not found' });
        }

        response.json({ post });
    } catch (error) {
        response.status(500).json({ error: 'Failed to get post' });
    }
});

// Get a post by slug
router.get('/:community_name/replies/:short_id/:slug', async (request, response) => {
    const { short_id, slug } = request.params;

    try {
        const post = await prisma.post.findUnique({
            where: { short_id },
        });

        if (!post) {
            return response.status(404).json({ error: 'Post not found' });
        }

        response.json({ post });
    } catch (error) {
        response.status(500).json({ error: 'Failed to get post' });
    }
});

export default router;
