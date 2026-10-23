import { env } from '../config/env';
import { HttpError } from './http';

export const isTurnstileEnabled = () => Boolean(env.TURNSTILE_SECRET_KEY);

// Verifies a Cloudflare Turnstile token. No-op when Turnstile is not configured (local dev, tests).
export async function requireTurnstile(token: string | undefined, ip?: string) {
    if (!env.TURNSTILE_SECRET_KEY) return;
    if (!token) throw new HttpError(400, 'captcha_required', 'Please complete the challenge.');

    const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, ...(ip ? { remoteip: ip } : {}) });
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    const result = (await response?.json().catch(() => null)) as { success?: boolean } | null;

    if (!result?.success) throw new HttpError(400, 'captcha_failed', 'The challenge failed. Please try again.');
}
