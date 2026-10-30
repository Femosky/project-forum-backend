import { User } from '@prisma/client';
import prisma from '../../prismaConnection';
import { HttpError } from '../../lib/http';

// New-account friction (Phase 5). Scam accounts are fresh and post fast, so young accounts get tighter limits,
// no links and stricter filters until they are a day old or have earned some karma.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const TRUST = {
    // Under a day old and short of LINK_KARMA: no links, contact-pattern filters, Turnstile on posting
    NEW_ACCOUNT_MS: DAY,
    LINK_KARMA: 10,
    // Under a week old and short of LINK_KARMA: posting and commenting are capped per hour
    YOUNG_ACCOUNT_MS: 7 * DAY,
    YOUNG_POSTS_PER_HOUR: 3,
    YOUNG_COMMENTS_PER_HOUR: 10,
    // Anonymous posting needs an account this old, a verified email and karma at or above this
    ANONYMOUS_MIN_AGE_MS: DAY,
    ANONYMOUS_MIN_KARMA: 0,
} as const;

const ageOf = (user: Pick<User, 'created_at'>) => Date.now() - user.created_at.getTime();

// Trusted accounts (marked by the site's admins) skip the new-account limits; every content check still applies
export const isNewAccount = (user: Pick<User, 'created_at' | 'karma' | 'is_trusted'>) =>
    !user.is_trusted && ageOf(user) < TRUST.NEW_ACCOUNT_MS && user.karma < TRUST.LINK_KARMA;

const isYoungAccount = (user: Pick<User, 'created_at' | 'karma' | 'is_trusted'>) =>
    !user.is_trusted && ageOf(user) < TRUST.YOUNG_ACCOUNT_MS && user.karma < TRUST.LINK_KARMA;

export const canPostLinks = (user: Pick<User, 'created_at' | 'karma' | 'is_trusted'>) => !isNewAccount(user);

// "about 9 hours", "about 40 minutes": how long until a limit lifts, for messages
export function roughly(ms: number) {
    const minutes = Math.max(1, Math.ceil(ms / 60000));
    if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.round(minutes / 60);
    return `about ${hours} hour${hours === 1 ? '' : 's'}`;
}

// When a new account can share links and pictures, and how much reputation would unlock them sooner
export function linkLimit(user: Pick<User, 'created_at' | 'karma' | 'is_trusted'>) {
    if (canPostLinks(user)) return null;
    const unlocksAt = new Date(user.created_at.getTime() + TRUST.NEW_ACCOUNT_MS);
    return { unlocks_at: unlocksAt.toISOString(), reputation_needed: TRUST.LINK_KARMA - user.karma };
}

function linkLimitError(user: User, code: 'new_account_links' | 'new_account_pictures') {
    const limit = linkLimit(user)!;
    return new HttpError(
        403,
        code,
        `New accounts can post links and pictures after 1 day or ${TRUST.LINK_KARMA} reputation. You can in ${roughly(
            new Date(limit.unlocks_at).getTime() - Date.now()
        )}.`,
        undefined,
        limit
    );
}

export function assertPicturesAllowed(user: User) {
    if (!canPostLinks(user)) throw linkLimitError(user, 'new_account_pictures');
}

// Anonymity is per post, and only for accounts in good standing
export const canPostAnonymously = (user: Pick<User, 'created_at' | 'karma' | 'email_verified_at' | 'shadow_banned_at'>) =>
    ageOf(user) >= TRUST.ANONYMOUS_MIN_AGE_MS &&
    user.email_verified_at !== null &&
    user.karma >= TRUST.ANONYMOUS_MIN_KARMA &&
    user.shadow_banned_at === null;

// What the web app needs to shape the composer (sent with the signed-in user)
export const trustFlags = (user: User) => {
    const limit = linkLimit(user);
    return {
        can_post_links: !limit,
        links_unlock_at: limit?.unlocks_at ?? null,
        reputation_needed: limit?.reputation_needed ?? 0,
        can_post_anonymously: canPostAnonymously(user),
    };
};

export function assertAnonymousAllowed(user: User, isAnonymous: boolean) {
    if (isAnonymous && !canPostAnonymously(user)) {
        throw new HttpError(
            403,
            'anonymous_not_allowed',
            'Anonymous posting opens once your account is a day old, your email is verified and your account is in good standing.'
        );
    }
}

// Links in a post or comment: explicit URLs, www. addresses, and well-known short or chat links written bare
const LINK = /\bhttps?:\/\/\S+|\bwww\.[a-z0-9-]+\.[a-z]{2,}\S*|\b(?:wa\.me|t\.me|chat\.whatsapp\.com|bit\.ly|tinyurl\.com)\/\S*/i;

export const containsLink = (text: string) => LINK.test(text);

export function assertLinksAllowed(user: User, texts: string[], url?: string) {
    if (canPostLinks(user)) return;
    if (url || texts.some(containsLink)) throw linkLimitError(user, 'new_account_links');
}

export async function assertWithinYoungAccountLimits(user: User, kind: 'post' | 'comment') {
    if (!isYoungAccount(user)) return;
    const since = new Date(Date.now() - HOUR);
    const where = { author_id: user.id, created_at: { gte: since } };
    const [count, limit] =
        kind === 'post'
            ? [await prisma.post.count({ where }), TRUST.YOUNG_POSTS_PER_HOUR]
            : [await prisma.comment.count({ where }), TRUST.YOUNG_COMMENTS_PER_HOUR];
    if (count < limit) return;
    // The limit lifts when enough of this hour's posts or comments are more than an hour old
    const page = { where, orderBy: { created_at: 'asc' as const }, skip: count - limit, take: 1, select: { created_at: true } };
    const [oldest] = kind === 'post' ? await prisma.post.findMany(page) : await prisma.comment.findMany(page);
    const retryAt = new Date((oldest?.created_at.getTime() ?? Date.now()) + HOUR);
    throw new HttpError(
        429,
        'new_account_limit',
        `New accounts can make ${limit} ${kind === 'post' ? 'posts' : 'comments'} an hour until they are a week old or have ${
            TRUST.LINK_KARMA
        } reputation. You can again in ${roughly(retryAt.getTime() - Date.now())}.`,
        undefined,
        { retry_at: retryAt.toISOString(), limit, reputation_needed: TRUST.LINK_KARMA - user.karma }
    );
}
