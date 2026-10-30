import { createHmac } from 'node:crypto';
import { env } from '../config/env';
import { safeEqual } from './tokens';

// Links in emails that work without signing in (unsubscribe, hide a community) carry a signature instead.
// kind: replies, mentions, digest, hide (ref: community name), mod (ref: community id)
export type EmailAction = { kind: string; userId: string; ref?: string };

const signature = (payload: string) => createHmac('sha256', env.JWT_SECRET).update(`email-action:${payload}`).digest('base64url');

export function emailToken({ kind, userId, ref = '' }: EmailAction) {
    const payload = Buffer.from(`${kind}:${userId}:${ref}`).toString('base64url');
    return `${payload}.${signature(payload)}`;
}

export function readEmailToken(token: string): EmailAction | null {
    const [payload, given] = token.split('.');
    if (!payload || !given || !safeEqual(given, signature(payload))) return null;
    const [kind, userId, ref] = Buffer.from(payload, 'base64url').toString().split(':');
    return kind && userId ? { kind, userId, ref: ref || undefined } : null;
}

// The page behind an email's unsubscribe link, and what List-Unsubscribe headers point at for one-click
export const unsubscribeLink = (action: EmailAction) => `${env.WEB_URL}/unsubscribe?token=${emailToken(action)}`;

export const unsubscribeHeaders = (action: EmailAction) => ({
    // Mail apps need a public https address; without API_URL set they just get the link in the email
    ...(env.API_URL.startsWith('https://') || env.IS_TEST
        ? { 'List-Unsubscribe': `<${env.API_URL}/v1/email/unsubscribe?token=${emailToken(action)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
        : {}),
});
