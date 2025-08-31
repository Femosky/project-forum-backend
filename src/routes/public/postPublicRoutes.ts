import { Router } from 'express';
import prisma from '../../prismaConnection';
import { PasswordService } from '../../utils/passwordService';
import { IdShortener } from '../../utils/IdShortener';
import { ErrorResponse } from '../../models/interfaces/errorType';

const router = Router();

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
        response.status(500).json({ error: 'Failed to get post', details: error } as ErrorResponse);
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
        response.status(500).json({ error: 'Failed to get post', details: error } as ErrorResponse);
    }
});

export default router;
