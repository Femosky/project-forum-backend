import jwt from 'jsonwebtoken';
import { CookieOptions, Response } from 'express';
import { env } from '../../config/env';
import { randomToken } from '../../lib/tokens';

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
// Cookie from the old auth flow; cleared on logout so it doesn't linger
const LEGACY_SESSION_COOKIE = 'session_id';

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

type AccessClaims = { sid: string; sub: string };

// Short-lived JWT naming the session; every request still checks the session is live, so revoking works at once.
export function signAccessToken(sessionId: string, userId: string) {
    return jwt.sign({ sid: sessionId, sub: userId, typ: 'access' }, env.JWT_SECRET, {
        expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        algorithm: 'HS256',
    });
}

export function verifyAccessToken(token: string): AccessClaims | null {
    try {
        const claims = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
        if (claims.typ !== 'access' || typeof claims.sid !== 'string' || typeof claims.sub !== 'string') return null;
        return { sid: claims.sid, sub: claims.sub };
    } catch {
        return null;
    }
}

// Refresh tokens are opaque: "<session id>.<random secret>". Only a hash of the secret is stored.
export const newRefreshSecret = () => randomToken(32);
export const formatRefreshToken = (sessionId: string, secret: string) => `${sessionId}.${secret}`;

export function parseRefreshToken(token: string | undefined): { sessionId: string; secret: string } | null {
    if (!token) return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    return { sessionId: token.slice(0, dot), secret: token.slice(dot + 1) };
}

// Secure + SameSite=Lax works when the web app and API share a parent domain (e.g. *.oskeylabs.com)
function cookieOptions(maxAge?: number): CookieOptions {
    return {
        httpOnly: true,
        secure: env.IS_PRODUCTION,
        sameSite: 'lax',
        path: '/',
        domain: env.COOKIE_DOMAIN,
        ...(maxAge ? { maxAge } : {}),
    };
}

export function setAccessCookie(response: Response, accessToken: string) {
    response.cookie(ACCESS_COOKIE, accessToken, cookieOptions(ACCESS_TOKEN_TTL_MS));
}

export function setAuthCookies(response: Response, tokens: { accessToken: string; refreshToken: string }) {
    setAccessCookie(response, tokens.accessToken);
    response.cookie(REFRESH_COOKIE, tokens.refreshToken, cookieOptions(SESSION_TTL_MS));
}

export function clearAuthCookies(response: Response) {
    for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, LEGACY_SESSION_COOKIE]) {
        response.clearCookie(name, cookieOptions());
    }
}
