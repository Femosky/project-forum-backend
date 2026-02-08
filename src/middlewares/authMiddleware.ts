import { Request, Response, NextFunction } from 'express';
import { User } from '@prisma/client';
import { DecodedToken, PasswordService } from '../services/PasswordService';
import prisma from '../prismaConnection';

export type AuthRequest = Request & { user?: User };

export async function authenticateToken(request: AuthRequest, response: Response, next: NextFunction) {
    const authHeader = request.headers['authorization'];
    const accessToken = authHeader?.split(' ')[1];

    if (!accessToken) {
        return response.status(401).json({ error: 'Unauthorized, no access token provided.' });
    }

    try {
        const decodedToken: DecodedToken | null = await PasswordService.verifyAccessToken(accessToken);

        if (!decodedToken) {
            return response.status(401).json({ error: 'Unauthorized, invalid access token.' });
        }

        const token = await prisma.authToken.findUnique({
            where: { id: decodedToken.authTokenId },
            include: { user: true },
        });

        if (!token) {
            return response.status(401).json({ error: 'Unauthorized, invalid access token.' });
        }

        request.user = token.user as User;
        next();
    } catch (error) {
        return response.status(500).json({ error: { message: 'Failed to authenticate token.', stack: error } });
    }
}
