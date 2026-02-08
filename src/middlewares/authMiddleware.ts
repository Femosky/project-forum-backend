import { Request, Response, NextFunction } from 'express';
import { User } from '@prisma/client';
import { DecodedTokenWithUser, PasswordService } from '../services/PasswordService';
import prisma from '../prismaConnection';

export type AuthRequest = Request & { user?: User };

// Authenticate access token
export async function authenticateToken(request: AuthRequest, response: Response, next: NextFunction) {
    // const authHeader = request.headers['authorization'];
    // const accessToken = authHeader?.split(' ')[1];
    const accessToken = request.cookies.access_token;
    const refreshToken = request.cookies.refresh_token;

    if (!accessToken && !refreshToken) {
        console.log('Unauthorized, no access token or refresh token provided MIDDLEWARE.');
        return response.status(401).json({ error: 'Unauthorized, no access token or refresh token provided.' });
    }

    try {
        // Verify access token
        const decodedToken: DecodedTokenWithUser | null = await PasswordService.verifyAccessToken(
            accessToken,
            refreshToken
        );

        if (!decodedToken) {
            return response.status(401).json({ error: 'Unauthorized, invalid access token.' });
        }

        request.user = decodedToken.user as User;
        next();
    } catch (error) {
        return response.status(500).json({ error: { message: 'Failed to authenticate token.', stack: error } });
    }
}
