import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Opaque random token for email links and refresh tokens; only its hash is stored.
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function safeEqual(a: string, b: string) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}
