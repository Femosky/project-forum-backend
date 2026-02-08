import { Router, Request, Response } from 'express';
import prisma from '../../prismaConnection';
import { DecodedToken, PasswordService } from '../../services/PasswordService';
import { TokenPair } from '../../services/PasswordService';
import { UserInterface, UserStatus, UserType } from '../../models/interfaces/userType';
import { UAParser } from 'ua-parser-js';
import { User } from '@prisma/client';
import { ErrorResponse } from '../../models/interfaces/errorType';
import { DeviceDetailsUtils } from '../../utils/DeviceDetailsUtils';

const router = Router();

// Login a user
router.post('/login', async (request, response) => {
    await loginUser(request, response);
});

// Register a new user
router.post('/signup', async (request, response) => {
    await signupUser(request, response);
});

// Refresh a short lived token
router.post('/refresh-token', async (request, response) => {
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
    const accessToken = request.cookies.access_token;
    const refreshToken = request.cookies.refresh_token;

    if (accessToken && refreshToken) {
        console.log('User already logged in.');
        console.log(accessToken, refreshToken);
    } else {
        console.log('User not logged in.');
    }

    if (!email && !username) {
        console.log(email, username);
        return response.status(400).json({ error: 'Email or username is required.' } as ErrorResponse);
    }

    if (!password) {
        return response.status(400).json({ error: 'Password is required.' } as ErrorResponse);
    }

    try {
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
        const loginSessionDetails = await getLoginSessionDetails(request);

        const loginSessions = await prisma.loginSession.findMany({
            where: { user_id: user.id, is_active: true },
        });

        const userIPInformation = await DeviceDetailsUtils.getUserIPInformation(request);

        // if (loginSessions.length > 0) {
        //     for (const loginSession of loginSessions) {
        //         if (
        //             loginSession.device_type === loginSessionDetails.device &&
        //             loginSession.browser === loginSessionDetails.browser &&
        //             loginSession.os === loginSessionDetails.os &&
        //             loginSession.user_agent === loginSessionDetails.userAgent &&
        //             loginSession.ip_address === loginSessionDetails.ipAddress
        //         ) {
        //             return response.json({
        //                 error: { message: 'User already logged in.', loginSessions, loginSession, userIPInformation },
        //             });
        //         }
        //     }
        // }

        // Generate tokens
        const tokens: TokenPair | ErrorResponse = await generateTokens(user);

        if ('error' in tokens) {
            return response.status(500).json({ error: tokens.error });
        }

        const loginSession = await createLoginSession(user as User, tokens, request);
        if (!loginSession) {
            return response.status(500).json({ error: 'Failed to create login session' } as ErrorResponse);
        }

        const { password_hash, ...safeUser } = user;

        const isProduction = process.env.NODE_ENV === 'production';

        response.cookie('access_token', tokens.access_token, {
            httpOnly: true,
            // secure: false,
            // sameSite: 'lax',
            // path: '/',
            // maxAge: PasswordService.ACCESS_TOKEN_EXPIRATION,
        });

        response.cookie('refresh_token', tokens.refresh_token, {
            httpOnly: true,
            // secure: false,
            // sameSite: 'lax',
            // path: '/',
            // maxAge: PasswordService.REFRESH_TOKEN_EXPIRATION,
        });

        response.json({ success: true, user: safeUser, tokens });
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

async function refreshToken(request: Request, response: Response) {
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

        response.json({ accessToken: newShortLivedToken });
    } catch (error) {
        response.status(500).json({ error: 'Internal server error.', details: error } as ErrorResponse);
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

    return await prisma.loginSession.create({
        data: {
            user_id: user.id,
            expires_at: longLivedExpiry || new Date(Date.now() + PasswordService.REFRESH_TOKEN_EXPIRATION * 1000),
            device_type: device,
            browser: browser,
            os: os,
            user_agent: userAgent,
            ip_address: ipAddress,
        },
    });
}

export default router;
