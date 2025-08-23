import { Router } from 'express';
import prisma from '../prismaConnection';
import { DecodedToken, PasswordService } from '../utils/passwordService';
import { TokenPair } from '../utils/passwordService';
import { User } from '../models/interfaces/userType';

const router = Router();

enum TokenType {
    API = 'api',
    EMAIL = 'email',
}

router.post('/login', async (request, response) => {
    const { email, username, password } = request.body;

    try {
        // Find user by email or username
        let user: User | null = null;

        if (email) {
            user = (await prisma.user.findUnique({
                where: { email },
            })) as User | null;
        } else if (username) {
            user = (await prisma.user.findUnique({
                where: { username },
            })) as User | null;
        } else {
            return response.json({ error: 'Email or username is required.' });
        }

        if (!user) {
            return response.json({ error: 'User not found.' });
        }

        // Verify password
        const isPasswordValid = await PasswordService.verifyPassword(password, user.password_hash);
        if (!isPasswordValid) {
            return response.json({ error: 'Invalid password.' });
        }

        // Create AuthToken
        const authToken = await prisma.authToken.create({
            data: {
                user: {
                    connect: { id: user.id },
                },
            },
        });

        // Generate Access and Refresh Tokens
        const tokens = await PasswordService.generateTokens(authToken.id);
        if (!tokens) {
            await prisma.authToken.delete({ where: { id: authToken.id } });
            return response.status(500).json({ error: { message: 'Could not generate tokens.' } });
        }

        const isAuthTokenUpdated = await prisma.authToken.update({
            where: { id: authToken.id },
            data: {
                short_lived_token: tokens.short_lived_token,
                long_lived_token: tokens.long_lived_token,
            },
        });

        if (!isAuthTokenUpdated) {
            await prisma.authToken.delete({ where: { id: authToken.id } });
            return response.status(500).json({ error: { message: 'Could not update auth token.' } });
        }

        response.json({
            message: 'Login sucessful.',
            success: true,
            tokens: {
                short_lived_token: tokens.short_lived_token,
                long_lived_token: tokens.long_lived_token,
            } as TokenPair,
            user,
        });
    } catch (error) {
        response.status(500).json({ error: { message: 'Internal server error.', stack: error } });
    }
});

router.post('/refresh-token', async (request, response) => {
    const { permanent_token } = request.body;

    try {
        // Verify refresh token and get token id
        const decoded: DecodedToken | null = await PasswordService.verifyRefreshToken(permanent_token);
        if (!decoded) {
            return response.status(401).json({ error: 'Invalid refresh token.' });
        }

        // Get new short lived token
        const newShortLivedToken = await PasswordService.generateAccessToken(decoded.authTokenId);
        if (!newShortLivedToken) {
            return response.status(500).json({ error: 'Could not generate short lived token.' });
        }

        const isAuthTokenUpdated = await prisma.authToken.update({
            where: { id: decoded.authTokenId },
            data: {
                short_lived_token: newShortLivedToken,
            },
        });

        if (!isAuthTokenUpdated) {
            return response.status(500).json({ error: 'Could not update auth token.' });
        }

        response.json({ accessToken: newShortLivedToken });
    } catch (error) {
        response.status(500).json({ error: { message: 'Internal server error.', stack: error } });
    }
});

export default router;
