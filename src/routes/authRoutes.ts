import { Router } from 'express';
import prisma from '../prismaConnection';
import { DecodedToken, LONG_LIVED_TOKEN_EXPIRATION, PasswordService } from '../utils/passwordService';
import { TokenPair } from '../utils/passwordService';
import { UserInterface, UserStatus, UserType } from '../models/interfaces/userType';
import { UAParser } from 'ua-parser-js';
import { User } from '@prisma/client';
import { ErrorResponse } from '../models/interfaces/errorType';

const router = Router();

enum TokenType {
    API = 'api',
    EMAIL = 'email',
}

async function generateTokens(user: User, response: any): Promise<TokenPair | ErrorResponse> {
    // Create AuthToken
    const authToken = await prisma.authToken.create({
        data: {
            user: {
                connect: { id: user.id },
            },
        },
    });

    if (!authToken) {
        return { error: 'Could not create auth token.' } as ErrorResponse;
    }

    // Generate Access and Refresh Tokens
    const tokens = await PasswordService.generateTokens(authToken.id);
    if (!tokens) {
        await prisma.authToken.delete({ where: { id: authToken.id } });
        return { error: 'Could not generate tokens.' } as ErrorResponse;
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
        return { error: 'Could not update auth token.' } as ErrorResponse;
    }

    return tokens;
}

// Login a user
router.post('/login', async (request, response) => {
    const { email, username, password } = request.body;

    try {
        // Find user by email or username
        let user: User | null = null;

        if (email) {
            user = (await prisma.user.findUnique({
                where: { email },
                select: {
                    id: true,
                    created_at: true,
                    updated_at: true,
                    last_login: true,
                    username: true,
                    email: true,
                    avatar_id: true,
                    account_status: true,
                    user_type: true,
                    is_email_verified: true,
                    notification_preferences: true,
                },
            })) as User | null;
        } else if (username) {
            user = (await prisma.user.findUnique({
                where: { username },
                select: {
                    id: true,
                    created_at: true,
                    updated_at: true,
                    last_login: true,
                    username: true,
                    email: true,
                    avatar_id: true,
                    account_status: true,
                    user_type: true,
                    is_email_verified: true,
                    notification_preferences: true,
                },
            })) as User | null;
        } else {
            return response.json({ error: 'Email or username is required.' });
        }

        console.log('got here');

        if (!user) {
            return response.json({ error: 'User not found.' });
        }

        // Verify password
        const isPasswordValid = await PasswordService.verifyPassword(password, user.password_hash);
        if (!isPasswordValid) {
            return response.json({ error: 'Invalid password.' });
        }

        // Generate tokens
        const tokens: TokenPair | ErrorResponse = await generateTokens(user, response);

        if ('error' in tokens) {
            return response.status(500).json({ error: tokens.error });
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

// Refresh a short lived token
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
        response.status(500).json({ error: 'Internal server error.', details: error } as ErrorResponse);
    }
});

interface LoginSessionDetails {
    userAgent: string | null;
    browser: string | null | undefined;
    os: string | null | undefined;
    device: string | null | undefined;
    ipAddress: string | null | undefined;
    error?: unknown;
}

async function getLoginSessionDetails(request: any): Promise<LoginSessionDetails> {
    try {
        const parser = new UAParser();
        const result = parser.getResult();
        const userAgent = result.ua;
        const browser = result.browser.name;
        const os = result.os.name;
        const device = result.device.type;
        const ipAddress =
            request.headers.get('x-forwarded-for') ||
            request.headers.get('x-real-ip') ||
            'unknown' ||
            (request as any).ip;

        return { userAgent, browser, os, device, ipAddress };
    } catch (error) {
        return { userAgent: null, browser: null, os: null, device: null, ipAddress: null, error: error as string };
    }
}

// Register a new user
router.post('/create-user', async (request, response) => {
    const { email, username, password } = request.body;

    if (!email || !username || !password) {
        return response.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const isEmailTaken = await prisma.user.findUnique({
            where: { email },
        });

        if (isEmailTaken) {
            return response.status(400).json({ error: 'Email already in use' });
        }

        const isUsernameTaken = await prisma.user.findUnique({
            where: { username },
        });

        if (isUsernameTaken) {
            return response.status(400).json({ error: 'Username already in use' });
        }

        const user = await prisma.user.create({
            data: {
                email,
                username,
                password_hash: password,
            },
            select: {
                id: true,
                created_at: true,
                updated_at: true,
                last_login: true,
                username: true,
                email: true,
                avatar_id: true,
                account_status: true,
                user_type: true,
                is_email_verified: true,
                notification_preferences: true,
            },
        });

        if (!user) {
            return response.status(400).json({ error: 'Failed to create user' });
        }

        // Generate tokens
        const tokens: TokenPair | ErrorResponse = await generateTokens(user as User, response);

        if ('error' in tokens) {
            return response.status(500).json({ error: tokens.error });
        }

        // Create login session
        const { userAgent, browser, os, device, ipAddress } = await getLoginSessionDetails(request);
        const longLivedExpiry = PasswordService.getTokenExpiry(tokens.long_lived_token);

        const loginSession = await prisma.loginSession.create({
            data: {
                user_id: user.id,
                expires_at: longLivedExpiry || LONG_LIVED_TOKEN_EXPIRATION,
                device_type: device,
                browser: browser,
                os: os,
                user_agent: userAgent,
                ip_address: ipAddress,
            },
        });

        if (!loginSession) {
            return response.status(500).json({ error: 'Failed to create login session' });
        }

        response.json({ message: 'Successfully created user', success: true, user, loginSession });
    } catch (error) {
        response.status(500).json({ error: 'Failed to create user', details: error });
    }
});

export default router;
