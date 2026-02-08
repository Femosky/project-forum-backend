import { Router, Request, Response } from 'express';
import prisma from '../../prismaConnection';
import { DecodedJWTToken, DecodedTokenWithUser, PasswordService } from '../../services/PasswordService';
import { TokenPair } from '../../services/PasswordService';
import { UAParser } from 'ua-parser-js';
import { User } from '@prisma/client';
import { ErrorResponse } from '../../models/interfaces/errorType';
import { DeviceDetailsUtils } from '../../utils/DeviceDetailsUtils';
import { authenticateToken, AuthRequest } from '../../middlewares/authMiddleware';

const router = Router();

// Login a user
router.post('/login', async (request, response) => {
    await loginUser(request, response);
});

// Logout a user
router.post('/logout', authenticateToken, async (request: AuthRequest, response) => {
    const user = request.user as User;
    try {
        if (!user) {
            console.log('User not authenticated.');
            return response.status(400).json({ error: 'User already logged out. Not authenticated.' } as ErrorResponse);
        }

        // Find active auth token
        const authToken = await prisma.authToken.findFirst({
            where: { user_id: user.id, valid: true },
            select: {
                id: true,
                login_session_id: true,
            },
        });

        if (!authToken || !authToken.login_session_id) {
            console.log('No active auth token or login session found.');
            return response
                .status(400)
                .json({ error: 'No active auth token or login session found.' } as ErrorResponse);
        }

        // Invalidate auth token
        const authTokenUpdated = await prisma.authToken.update({
            where: { id: authToken.id },
            data: {
                valid: false,
            },
        });

        if (!authTokenUpdated) {
            console.log('Failed to invalidate auth token.');
            return response.status(400).json({ error: 'Failed to invalidate auth token.' } as ErrorResponse);
        }

        // Invalidate login session
        const loginSession = await prisma.loginSession.update({
            where: { id: authToken.login_session_id as string },
            data: { is_active: false, expires_at: new Date() },
        });

        if (!loginSession) {
            console.log('Failed to invalidate login session.');
            return response.status(400).json({ error: 'Failed to invalidate login session.' } as ErrorResponse);
        }

        response.status(200).json({ success: true, message: 'Logged out successfully.' });
    } catch (error) {
        response.status(500).json({ error: 'Failed to logout.', details: error } as ErrorResponse);
    }
});

// Register a new user
router.post('/signup', async (request, response) => {
    await signupUser(request, response);
});

// Refresh a short lived token
router.post('/refresh-token', authenticateToken, async (request: AuthRequest, response) => {
    await refreshToken(request, response);
});

interface LoginSessionDetails {
    userAgent: string | null;
    browser: string | null | undefined;
    os: string | null | undefined;
    device: string | null | undefined;
    ipAddress: string | null | undefined;
    error?: unknown;
}

async function generateTokens(user: User): Promise<TokenPair | ErrorResponse> {
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
            refresh_token: tokens.refresh_token,
        },
    });

    if (!isAuthTokenUpdated) {
        await prisma.authToken.delete({ where: { id: authToken.id } });
        return { error: 'Could not update auth token.' } as ErrorResponse;
    }

    return tokens;
}

async function loginUser(request: Request, response: Response) {
    const { email, username, password } = request.body;
    const refreshToken = request.cookies.refresh_token;

    try {
        // Validate request body
        if (!email && !username) {
            return response.status(400).json({ error: 'Email or username is required.' } as ErrorResponse);
        }

        if (!password) {
            return response.status(400).json({ error: 'Password is required.' } as ErrorResponse);
        }

        // Find user by email or username
        let user: User | null = null;

        if (email) {
            user = (await prisma.user.findUnique({
                where: { email: email.toLowerCase() },
            })) as User | null;
        } else if (username) {
            user = (await prisma.user.findUnique({
                where: { username: username.toLowerCase() },
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

        // Check if user is already logged in via refresh token
        if (refreshToken) {
            const decoded: DecodedJWTToken | null = await PasswordService.verifyRefreshToken(refreshToken, user.id);
            if (decoded) {
                return response.json({ error: 'User already logged in.' });
            }
        }

        // Get login session details
        const loginSessionDetails = await getLoginSessionDetails(request);

        // const loginSessions = await prisma.loginSession.findMany({
        //     where: { user_id: user.id, is_active: true },
        // });

        const userIPInformation = await DeviceDetailsUtils.getUserIPInformation(request);

        // Generate tokens
        const tokens: TokenPair | ErrorResponse = await generateTokens(user);

        if ('error' in tokens) {
            return response.status(500).json({ error: tokens.error });
        }

        // Create login session
        const loginSession = await createLoginSession(user as User, tokens, request);
        if (!loginSession) {
            return response.status(500).json({ error: 'Failed to create login session' } as ErrorResponse);
        }

        // Connect auth token to login session
        const authTokenUpdated = await prisma.authToken.update({
            where: { id: tokens.auth_token_id },
            data: {
                login_session_id: loginSession.id,
            },
        });

        if (!authTokenUpdated) {
            return response
                .status(500)
                .json({ error: 'Failed to connect auth token to login session' } as ErrorResponse);
        }

        const { password_hash, ...safeUser } = user;

        // const isProduction = process.env.NODE_ENV === 'production';

        response.cookie(PasswordService.ACCESS_TOKEN_NAME, tokens.access_token, {
            httpOnly: true,
            // secure: false,
            // sameSite: 'lax',
            // path: '/',
            // maxAge: PasswordService.ACCESS_TOKEN_EXPIRATION,
        });

        response.cookie(PasswordService.REFRESH_TOKEN_NAME, tokens.refresh_token, {
            httpOnly: true,
            // secure: false,
            // sameSite: 'lax',
            // path: '/',
            // maxAge: PasswordService.REFRESH_TOKEN_EXPIRATION,
        });

        response.json({ success: true, user: safeUser });
    } catch (error) {
        response.status(500).json({ error: 'Failed to login.', details: error } as ErrorResponse);
    }
}

async function signupUser(request: Request, response: Response) {
    const { email, username, password } = request.body;

    if (!email || !username || !password) {
        return response.status(400).json({ error: 'Email, username and password are required' } as ErrorResponse);
    }

    try {
        const isEmailTaken = await prisma.user.findUnique({
            where: { email: email.toLowerCase() },
        });

        if (isEmailTaken) {
            return response.status(400).json({ error: 'Email already in use' } as ErrorResponse);
        }

        const isUsernameTaken = await prisma.user.findUnique({
            where: { username: username.toLowerCase() },
        });

        if (isUsernameTaken) {
            return response.status(400).json({ error: 'Username already in use' } as ErrorResponse);
        }

        const hashedPassword = await PasswordService.hashPassword(password);

        const user = await prisma.user.create({
            data: {
                email: email.toLowerCase(),
                username: username.toLowerCase(),
                password_hash: hashedPassword,
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
            return response.status(400).json({ error: 'Failed to create user' } as ErrorResponse);
        }

        await loginUser(request, response);
    } catch (error) {
        response.status(500).json({ error: 'Failed to create user', details: error } as ErrorResponse);
    }
}

async function refreshToken(request: AuthRequest, response: Response) {
    const refreshToken = request.cookies.refresh_token;
    const user = request.user as User;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized, user not authenticated.' });
    }

    try {
        if (!refreshToken) {
            return response.status(401).json({ error: 'No refresh token provided.' });
        }

        // Verify refresh token and get token id
        const decoded: DecodedJWTToken | null = await PasswordService.verifyRefreshToken(refreshToken, user.id);
        if (!decoded) {
            return response.status(401).json({ error: 'Invalid refresh token.' }); // Could add reason later
        }

        // Get new short lived token
        const newAccessToken = await PasswordService.generateAccessToken(decoded.authTokenId);
        if (!newAccessToken) {
            return response.status(500).json({ error: 'Could not generate new access token.' });
        }

        response.cookie(PasswordService.ACCESS_TOKEN_NAME, newAccessToken, {
            httpOnly: true,
            // secure: false,
            // sameSite: 'lax',
            // path: '/',
            // maxAge: PasswordService.ACCESS_TOKEN_EXPIRATION,
        });

        response.json({ success: true, message: 'New access token refreshed successfully.' });
    } catch (error) {
        response.status(500).json({ error: 'Failed to refresh token.', details: error } as ErrorResponse);
    }
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

async function createLoginSession(user: User, tokens: TokenPair, request: any) {
    // Create login session
    const { userAgent, browser, os, device, ipAddress } = await getLoginSessionDetails(request);
    const longLivedExpiry = PasswordService.getTokenExpiry(tokens.refresh_token);

    if (!longLivedExpiry) {
        throw new Error('Failed to create login session, refresh token expired/invalid.');
    }

    return await prisma.loginSession.create({
        data: {
            user_id: user.id,
            expires_at: longLivedExpiry,
            device_type: device,
            browser: browser,
            os: os,
            user_agent: userAgent,
            ip_address: ipAddress,
        },
    });
}

export default router;
