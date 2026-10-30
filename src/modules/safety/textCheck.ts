import type { Verdict } from './moderation';

// The site's own explicit-content check for text: no outside service. The rule is no porn or explicit sexual content
// anywhere (NSFW only means mature: graphic news, sexual health, strong language), so this looks for the vocabulary of
// porn and of selling sex, not for sex as a topic: "sex education", "my sexual health" or "condoms" don't match.
//   - explicit terms: held for the site's admins (a person decides; nothing is deleted);
//   - explicit terms together with words about children, or terms that only point at minors: held for the admins
//     with a warning not to approve it.
// Text is normalised first, so spacing, punctuation, accents, repeated letters and number-for-letter swaps
// (p0rn, p.o.r.n, pooorn) don't get past it. The lists are deliberately short and specific: a match only means a
// person looks at it. Add to them here; tests/safety-text.test.ts shows what must and mustn't match.

// Porn, explicit acts, and selling sex (including Nigerian slang for it)
const EXPLICIT = [
    'porn',
    'porno',
    'pornography',
    'pornhub',
    'xvideos',
    'xhamster',
    'xxx',
    'sextape',
    'sex tape',
    'nudes',
    'send nudes',
    'leaked nudes',
    'naked pics',
    'dick pic',
    'blowjob',
    'handjob',
    'cumshot',
    'creampie',
    'gangbang',
    'deepthroat',
    'hentai',
    'onlyfans',
    'fansly',
    'camgirl',
    'cam girl',
    'escort service',
    'runs girl',
    'hookup girl',
    'sex for money',
];

// Words about children; on their own they're everyday words, only a match with the list above counts
const MINORS = ['child', 'children', 'kid', 'kids', 'minor', 'minors', 'underage', 'under age', 'teen', 'teens', 'teenager', 'preteen', 'schoolgirl', 'school girl', 'pupil'];

// Terms that only ever point at sexual content involving minors
const MINOR_ONLY = ['loli', 'lolicon', 'shota', 'shotacon', 'jailbait', 'child porn', 'cp links', 'pedo', 'paedo'];

// An age under 18 written out: "15yo", "16 y/o", "14 years old", "17yrs"
const UNDERAGE = /(?<![\d])(?:[1-9]|1[0-7])\s*(?:yo|y\/o|yrs?|years?\s*old)(?![a-z])/;

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i', '|': 'l' };

// Lowercase, no accents, number-for-letter swaps undone, letters split by single separators joined back up
// ("p.o.r.n", "p o r n" -> "porn"), and any other punctuation turned into spaces
export function normalise(text: string): string {
    let out = text
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        // Leetspeak only inside words, so prices and ages ("15yo") keep their digits
        // (between letters, after a letter, or before two letters unless it's an age like "15yo")
        .replace(/(?<=[a-z])[013457@$!|]+(?=[a-z])|(?<=[a-z])[013457@$!|]+|(?<![\d])[013457@$!|]+(?!\d)(?=[a-z]{2})(?!yo|y\/o|yrs?|years?)/g, (run) =>
            [...run].map((char) => LEET[char] ?? char).join('')
        );
    // Single letters joined by dots, dashes, stars, underscores or single spaces: "p.o.r.n", "x x x"
    out = out.replace(/\b(?:[a-z][\s.\-*_]){2,}[a-z]\b/g, (run) => run.replace(/[\s.\-*_]/g, ''));
    return out.replace(/[^a-z0-9/\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// A term as a pattern on normalised text: whole words, each letter possibly stretched ("pooorn"), plural allowed
function pattern(term: string): RegExp {
    const body = term
        .split(' ')
        .map((word) => [...word].map((char) => `${char}+`).join(''))
        .join('\\s?');
    return new RegExp(`(?<![a-z])${body}(?:e?s)?(?![a-z])`);
}

const EXPLICIT_PATTERNS = EXPLICIT.map(pattern);
const MINOR_PATTERNS = MINORS.map(pattern);
const MINOR_ONLY_PATTERNS = MINOR_ONLY.map(pattern);

export function judgeText(text: string): Verdict {
    const clean = normalise(text);
    if (!clean) return { action: 'publish' };
    const explicit = EXPLICIT_PATTERNS.some((re) => re.test(clean));
    const minors = MINOR_PATTERNS.some((re) => re.test(clean)) || UNDERAGE.test(clean);
    if (MINOR_ONLY_PATTERNS.some((re) => re.test(clean)) || (explicit && minors)) {
        return { action: 'hold_for_admins', reason: 'Possible sexual content involving a minor. Do not approve: remove it, and report it if confirmed.' };
    }
    if (explicit) return { action: 'hold_for_admins', reason: 'Explicit sexual content (not allowed anywhere on the site)' };
    return { action: 'publish' };
}
