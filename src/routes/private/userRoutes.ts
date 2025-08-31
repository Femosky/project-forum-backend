import { Router } from 'express';
import prisma from '../../prismaConnection';

const router = Router();

router.get('/', async (request, response) => {
    const users = await prisma.user.findFirst();
    response.json(users);
});

export default router;
