import { Request } from 'express';
import * as bcrypt from 'bcrypt';
import { Prisma, TokenPurpose, User } from '@prisma/client';
import { UAParser } from 'ua-parser-js';
import prisma from '../../prismaConnection';
import { env } from '../../config/env';
import { HttpError, badRequest, conflict, unauthorized } from '../../lib/http';
import { hashToken, randomToken, safeEqual } from '../../lib/tokens';
import { linkEmail } from '../../lib/email';
import { emailJob } from './jobs';
import {
    formatRefreshToken,
    newRefreshSecret,
    parseRefreshToken,
    SESSION_TTL_MS,
    signAccessToken,
} from './tokens';

const SALT_ROUNDS = 10;
// Two tabs refreshing at the same moment both present the old token; within this window that is not theft
const ROTATION_GRACE_MS = 30_000;

const TOKEN_TTL_MS: Record<TokenPurpose, number> = {
    verify_email: 48 * 60 * 60 * 1000,
    reset_password: 60 * 60 * 1000,
    change_email: 24 * 60 * 60 * 1000,
};

export const hashPassword = (password: string) => bcrypt.hash(password, SALT_ROUNDS);
export const verifyPassword = (password: string, hash: string | null) =>
    hash ? bcrypt.compare(password, hash) : Promise.resolve(false);

// What the signed-in user may see about themselves
export function toPrivateUser(user: User) {
    return {
        id: user.id,
        username: user.username,
        email: user.email,
        display_name: user.display_name,
        avatar_id: user.avatar_id,
        role: user.role,
        status: user.status,
        karma: user.karma,
        is_email_verified: user.email_verified_at !== null,
        has_password: user.password_hash !== null,
        has_google: user.google_id !== null,
        created_at: user.created_at,
    };
}

export type Tokens = { accessToken: string; refreshToken: string };

function deviceDetails(request: Request) {
    const result = new UAParser(request.headers['user-agent']).getResult();
    return {
        user_agent: result.ua ? result.ua.slice(0, 512) : null,
        browser: result.browser.name ?? null,
        os: result.os.name ?? null,
        device_type: result.device.type ?? null,
        // request.ip honours X-Forwarded-For because 'trust proxy' is set in app.ts
        ip_address: request.ip ?? null,
        // Set by Cloudflare when the API sits behind it
        country: (request.headers['cf-ipcountry'] as string | undefined)?.slice(0, 2) ?? null,
    };
}

export async function createSession(user: User, request: Request): Promise<Tokens> {
    const secret = newRefreshSecret();
    const session = await prisma.session.create({
        data: {
            user_id: user.id,
            refresh_token_hash: hashToken(secret),
            expires_at: new Date(Date.now() + SESSION_TTL_MS),
            ...deviceDetails(request),
        },
    });
    await prisma.user.update({ where: { id: user.id }, data: { last_login_at: new Date() } });
    return { accessToken: signAccessToken(session.id, user.id), refreshToken: formatRefreshToken(session.id, secret) };
}

export type RefreshResult = { tokens: Tokens } | { accessToken: string };

// Rotates the refresh token. Replaying an old token (outside the short grace window) revokes the whole session,
// because it means someone else has a copy.
export async function refreshSession(rawToken: string | undefined): Promise<RefreshResult> {
    const parsed = parseRefreshToken(rawToken);
    if (!parsed) throw unauthorized('Session expired. Please sign in again.', 'session_expired');

    const session = await prisma.session
        .findUnique({ where: { id: parsed.sessionId }, include: { user: true } })
        .catch(() => null);
    if (!session || session.revoked_at || session.expires_at <= new Date() || session.user.status !== 'active') {
        throw unauthorized('Session expired. Please sign in again.', 'session_expired');
    }

    const presented = hashToken(parsed.secret);

    if (safeEqual(presented, session.refresh_token_hash)) {
        const secret = newRefreshSecret();
        // Only rotate if nobody else rotated in the meantime
        const updated = await prisma.session.updateMany({
            where: { id: session.id, refresh_token_hash: session.refresh_token_hash },
            data: {
                previous_token_hash: session.refresh_token_hash,
                refresh_token_hash: hashToken(secret),
                rotated_at: new Date(),
                last_used_at: new Date(),
                expires_at: new Date(Date.now() + SESSION_TTL_MS),
            },
        });
        if (updated.count === 1) {
            return {
                tokens: {
                    accessToken: signAccessToken(session.id, session.user_id),
                    refreshToken: formatRefreshToken(session.id, secret),
                },
            };
        }
        // Lost a race with a parallel refresh: treat like the grace case below
        return { accessToken: signAccessToken(session.id, session.user_id) };
    }

    const withinGrace =
        session.previous_token_hash !== null &&
        safeEqual(presented, session.previous_token_hash) &&
        session.rotated_at !== null &&
        Date.now() - session.rotated_at.getTime() < ROTATION_GRACE_MS;
    if (withinGrace) {
        return { accessToken: signAccessToken(session.id, session.user_id) };
    }

    await prisma.session.update({ where: { id: session.id }, data: { revoked_at: new Date() } });
    throw unauthorized('Session expired. Please sign in again.', 'session_revoked');
}

export async function revokeSessionByRefreshToken(rawToken: string | undefined) {
    const parsed = parseRefreshToken(rawToken);
    if (!parsed) return;
    const session = await prisma.session.findUnique({ where: { id: parsed.sessionId } }).catch(() => null);
    if (session && safeEqual(hashToken(parsed.secret), session.refresh_token_hash)) {
        await prisma.session.update({ where: { id: session.id }, data: { revoked_at: new Date() } });
    }
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string) {
    await prisma.session.updateMany({
        where: { user_id: userId, revoked_at: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
        data: { revoked_at: new Date() },
    });
}

export async function findUserByIdentifier(identifier: string) {
    const value = identifier.trim().toLowerCase();
    return prisma.user.findUnique({ where: value.includes('@') ? { email: value } : { username: value } });
}

export async function assertAvailable(email: string, username: string) {
    const taken = await prisma.user.findFirst({
        where: { OR: [{ email }, { username }] },
        select: { email: true, username: true },
    });
    if (taken?.username === username) throw conflict('That username is taken.', 'username_taken');
    if (taken?.email === email) throw conflict('An account with that email already exists.', 'email_taken');
}

export async function createUser(data: { email: string; username: string; password_hash?: string; google_id?: string; verified?: boolean }) {
    try {
        return await prisma.user.create({
            data: {
                email: data.email,
                username: data.username,
                password_hash: data.password_hash ?? null,
                google_id: data.google_id ?? null,
                email_verified_at: data.verified ? new Date() : null,
                adult_attested_at: new Date(),
            },
        });
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw conflict('That username or email is already in use.', 'account_exists');
        }
        throw error;
    }
}

// Issues a single-use email token. Earlier unused tokens for the same purpose stop working.
export async function issueToken(userId: string, purpose: TokenPurpose, newEmail?: string) {
    const token = randomToken(32);
    await prisma.$transaction([
        prisma.verificationToken.updateMany({
            where: { user_id: userId, purpose, used_at: null },
            data: { used_at: new Date() },
        }),
        prisma.verificationToken.create({
            data: {
                user_id: userId,
                purpose,
                token_hash: hashToken(token),
                new_email: newEmail ?? null,
                expires_at: new Date(Date.now() + TOKEN_TTL_MS[purpose]),
            },
        }),
    ]);
    return token;
}

// Marks a token used and returns it, or throws if it is unknown, used or expired
export async function consumeToken(token: string, purpose: TokenPurpose) {
    const record = await prisma.verificationToken.findUnique({ where: { token_hash: hashToken(token) } });
    if (!record || record.purpose !== purpose || record.used_at || record.expires_at <= new Date()) {
        throw badRequest('This link is invalid or has expired.', 'invalid_token');
    }
    const claimed = await prisma.verificationToken.updateMany({
        where: { id: record.id, used_at: null },
        data: { used_at: new Date() },
    });
    if (claimed.count !== 1) throw badRequest('This link is invalid or has expired.', 'invalid_token');
    return record;
}

export async function sendVerificationEmail(user: Pick<User, 'id' | 'email'>) {
    const token = await issueToken(user.id, 'verify_email');
    await emailJob.enqueue(
        linkEmail(
            user.email,
            'Confirm your email',
            'Welcome! Confirm your email address to finish setting up your account.',
            'Confirm email',
            `${env.WEB_URL}/auth/verify-email?token=${token}`,
            'If you did not sign up, you can ignore this email.'
        )
    );
}

export async function sendPasswordResetEmail(user: Pick<User, 'id' | 'email'>) {
    const token = await issueToken(user.id, 'reset_password');
    await emailJob.enqueue(
        linkEmail(
            user.email,
            'Reset your password',
            'Someone asked to reset the password for your account. The link works for one hour.',
            'Choose a new password',
            `${env.WEB_URL}/auth/reset-password?token=${token}`,
            'If this was not you, ignore this email; your password has not changed.'
        )
    );
}

export async function sendEmailChangeConfirmation(user: Pick<User, 'id' | 'email'>, newEmail: string) {
    const token = await issueToken(user.id, 'change_email', newEmail);
    await emailJob.enqueue(
        linkEmail(
            newEmail,
            'Confirm your new email',
            'Confirm this address to use it for your account.',
            'Confirm new email',
            `${env.WEB_URL}/auth/confirm-email?token=${token}`
        )
    );
    await emailJob.enqueue({
        to: user.email,
        subject: 'Your email is being changed',
        text: `Someone asked to move your account to ${newEmail}. If this was not you, reset your password now.`,
    });
}

export function assertCanSignIn(user: User) {
    if (user.status === 'suspended' || user.status === 'banned') {
        throw new HttpError(403, 'account_suspended', 'This account is suspended.');
    }
    if (user.status === 'deleted') throw unauthorized('Invalid email, username or password.', 'invalid_credentials');
}
