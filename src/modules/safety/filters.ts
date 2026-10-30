import { BlockedTerm, User } from '@prisma/client';
import prisma from '../../prismaConnection';
import { isNewAccount } from './policy';

// Automatic filters (Phase 5). The first abuse wave on a forum like this is scams (fake jobs, loans, crypto and
// romance), not trolling, so the filters look for what scams need: a way to move the conversation somewhere
// private, a phone number, a shortened link, the same message pasted across communities, and anything on the
// admins' blocklist. A match holds the item for review (status pending, in the mod queue); nothing is deleted.
// The patterns are deliberately narrow so posts in Pidgin, Yoruba, Igbo or Hausa aren't caught by accident.

const HOUR = 60 * 60 * 1000;

const SHORTENERS = [
    'bit.ly', 'tinyurl.com', 'cutt.ly', 'rb.gy', 'is.gd', 'shorturl.at', 'tiny.cc', 'ow.ly', 'buff.ly', 'rebrand.ly',
    's.id', 't.ly', 'shorte.st', 'adf.ly', 'bl.ink', 'lnkd.in', 'v.gd', 'qr.ae', 'tr.im', 'goo.gl',
];

// "DM me", "WhatsApp me", "inbox us", "call me on", plus chat links that skip the site entirely
const CONTACT_PATTERNS = [
    /\b(?:dm|inbox|pm|message|text|call|whatsapp|whats\s?app|telegram|chat)\s+(?:me|us)\b/i,
    /\b(?:whatsapp|whats\s?app|telegram)\s*(?:number|no\.?|line|contact)\b/i,
    /\b(?:wa\.me|t\.me|chat\.whatsapp\.com)\//i,
];

// A run of 10 to 15 digits, allowing spaces, dashes, dots and brackets between them (+234 803 123 4567,
// 0803-123-4567). Commas aren't separators, so prices like 1,500,000 don't count.
const PHONE_CANDIDATE = /\+?\d[\d\s\-.()]{8,}\d/g;

export function containsPhoneNumber(text: string) {
    for (const match of text.matchAll(PHONE_CANDIDATE)) {
        const digits = match[0].replace(/\D/g, '').length;
        if (digits >= 10 && digits <= 15) return true;
    }
    return false;
}

export const asksForPrivateContact = (text: string) => CONTACT_PATTERNS.some((pattern) => pattern.test(text));

const COMMON_TLD = /\.(?:com|net|org|ng|io|co|me|info|biz|xyz|link|site|online|top|ly|cc|gd|at|uk)$/;

// Hostnames of every link in the text, with or without a scheme
export function linkHosts(text: string): string[] {
    const hosts = new Set<string>();
    for (const match of text.matchAll(/\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[/:?#\s)\]]|$)/gi)) {
        // A bare word like "node.js" only counts with a scheme, "www." or a common link TLD
        const host = match[1].toLowerCase().replace(/^www\./, '');
        const explicit = /^https?:\/\//i.test(match[0]) || /^www\./i.test(match[1]);
        if (explicit || SHORTENERS.includes(host) || COMMON_TLD.test(host)) hosts.add(host);
    }
    return [...hosts];
}

const hostMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The blocklist changes rarely and is read on every post, so it is cached briefly. Admin edits clear the cache.
let cache: { terms: BlockedTerm[]; at: number } | null = null;
const CACHE_MS = 60_000;

export async function blockedTerms() {
    if (!cache || Date.now() - cache.at > CACHE_MS) {
        cache = { terms: await prisma.blockedTerm.findMany(), at: Date.now() };
    }
    return cache.terms;
}

export const clearBlocklistCache = () => {
    cache = null;
};

export type ScreenInput = {
    user: User;
    kind: 'post' | 'comment';
    title?: string;
    body: string;
    url?: string;
    // For the repeated-content check: the post being commented on, or the community being posted to
    postId?: string;
    communityId?: string;
};

// Returns why the item should be held for review, or null to publish it
export async function screenContent(input: ScreenInput): Promise<string | null> {
    const text = [input.title, input.body, input.url].filter(Boolean).join('\n');
    const hosts = linkHosts(text);

    const terms = await blockedTerms();
    const blockedDomain = terms.find((term) => term.kind === 'domain' && hosts.some((host) => hostMatches(host, term.value)));
    if (blockedDomain) return `Links to a blocked domain (${blockedDomain.value})`;

    const shortener = hosts.find((host) => SHORTENERS.some((domain) => hostMatches(host, domain)));
    if (shortener) return `Uses a link shortener (${shortener})`;

    const lower = text.toLowerCase();
    const keyword = terms.find(
        (term) => term.kind === 'keyword' && new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(term.value)}(?:$|[^\\p{L}\\p{N}])`, 'u').test(lower)
    );
    if (keyword) return `Contains a blocked phrase ("${keyword.value}")`;

    if (isNewAccount(input.user)) {
        if (containsPhoneNumber(text)) return 'New account sharing a phone number';
        if (asksForPrivateContact(text)) return 'New account asking readers to contact them privately';
    }

    return repeatedContent(input);
}

// The same post pasted into another community, or the same comment pasted under three or more posts, in a day
async function repeatedContent(input: ScreenInput): Promise<string | null> {
    const since = new Date(Date.now() - 24 * HOUR);
    if (input.kind === 'post') {
        const body = input.body.trim();
        const same = [
            ...(input.title ? [{ title: { equals: input.title.trim(), mode: 'insensitive' as const } }] : []),
            ...(body.length >= 30 ? [{ body }] : []),
        ];
        if (same.length === 0) return null;
        const copies = await prisma.post.count({
            where: { author_id: input.user.id, created_at: { gte: since }, community_id: { not: input.communityId }, OR: same },
        });
        return copies > 0 ? 'Same post in another community' : null;
    }

    const body = input.body.trim();
    if (body.length < 20) return null;
    const copies = await prisma.comment.findMany({
        where: { author_id: input.user.id, created_at: { gte: since }, body, post_id: { not: input.postId } },
        distinct: ['post_id'],
        select: { post_id: true },
        take: 2,
    });
    return copies.length >= 2 ? 'Same comment under several posts' : null;
}
