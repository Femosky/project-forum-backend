import { createHash } from 'node:crypto';
import { env } from '../../config/env';
import { HttpError } from '../../lib/http';
import logger from '../../lib/logger';

// Rules for new passwords, on top of the length in shared/validation: not built from the username or email, and
// not in a known data breach. The breach check uses Have I Been Pwned's range API (k-anonymity): only the first 5
// characters of the password's SHA-1 leave the server, and the match happens here. If the service is slow or down
// the password is allowed, so sign-ups never depend on it.

const PWNED_RANGE = 'https://api.pwnedpasswords.com/range/';
const PWNED_TIMEOUT_MS = 2000;

export async function isBreached(password: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
    const hash = createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    try {
        const response = await fetchImpl(PWNED_RANGE + prefix, {
            headers: { 'Add-Padding': 'true', 'User-Agent': 'project-forum' },
            signal: AbortSignal.timeout(PWNED_TIMEOUT_MS),
        });
        if (!response.ok) return false;
        const body = await response.text();
        return body.split('\n').some((line) => {
            const [candidate, count] = line.trim().split(':');
            return candidate === suffix && Number(count) > 0;
        });
    } catch (error) {
        logger.warn({ err: error }, 'Password breach check skipped');
        return false;
    }
}

// The parts of a username or email someone might reuse as a password ("ada", "ada.obi")
function personalParts(username?: string, email?: string) {
    const local = email?.split('@')[0];
    return [username, local, ...(local?.split(/[._+-]/) ?? [])]
        .map((part) => part?.toLowerCase().trim())
        .filter((part): part is string => Boolean(part && part.length >= 3));
}

export async function assertStrongPassword(password: string, who: { username?: string; email?: string } = {}) {
    const lower = password.toLowerCase();
    if (personalParts(who.username, who.email).some((part) => lower.includes(part))) {
        throw new HttpError(400, 'weak_password', "Your password can't contain your username or email.", {
            password: "Can't contain your username or email",
        });
    }
    if (env.PASSWORD_BREACH_CHECK && (await isBreached(password))) {
        throw new HttpError(400, 'breached_password', 'That password has appeared in a data breach. Please choose another.', {
            password: 'This password has appeared in a data breach. Choose another.',
        });
    }
}
