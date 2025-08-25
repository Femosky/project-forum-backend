import { Router } from 'express';
import prisma from '../prismaConnection';
import { UserInterface } from '../models/interfaces/userType';
import { AuthRequest } from '../middlewares/authMiddleware';
const router = Router();

router.post('/create-community', async (request: AuthRequest, response) => {
    const { name, description } = request.body;
    const user = request.user;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized, invalid short lived token.' });
    }

    try {
        // create a new community
        const community = await prisma.community.create({
            data: {
                name,
                description,
                created_by: user.id,
            },
        });

        if (!community) {
            return response.status(500).json({ error: { message: 'Could not create community.' } });
        }

        response.json({ community });
    } catch (error) {
        response.status(500).json({ error: { message: 'Internal server error.', stack: error } });
    }
});

export default router;
