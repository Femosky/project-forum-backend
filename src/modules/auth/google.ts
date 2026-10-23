import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../../config/env';
import { HttpError, unauthorized } from '../../lib/http';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export type GoogleIdentity = { googleId: string; email: string; name?: string };

// Verifies a Google Identity Services ID token (signature, issuer, audience, expiry)
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
    if (!env.GOOGLE_CLIENT_ID) {
        throw new HttpError(503, 'google_not_configured', 'Google sign-in is not available yet.');
    }
    try {
        const { payload } = await jwtVerify(idToken, googleKeys, {
            issuer: ['https://accounts.google.com', 'accounts.google.com'],
            audience: env.GOOGLE_CLIENT_ID,
        });
        if (typeof payload.sub !== 'string' || typeof payload.email !== 'string' || payload.email_verified !== true) {
            throw new Error('Google account has no verified email');
        }
        return {
            googleId: payload.sub,
            email: payload.email.toLowerCase(),
            name: typeof payload.name === 'string' ? payload.name : undefined,
        };
    } catch {
        throw unauthorized('Google sign-in failed. Please try again.', 'google_failed');
    }
}
