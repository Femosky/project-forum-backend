// Trending topics: words and two-word phrases that many different people are suddenly using in post titles, plus
// flairs many people are posting under. Plain TypeScript over a few thousand titles, so it's easy to test and tune.
//
// A term trends when at least MIN_AUTHORS different people used it in the last few days and it's used more than
// usual: its score is divided by how often it appeared in the baseline (the month before). Words that are always
// common ("help", "best", "anyone") never trend; "election", "bbnaija" or "super eagles" do when the moment comes.

export type TitleRow = { id: string; title: string; author_id: string; community_id: string; community: string; flair: string | null };

export type Topic = {
    kind: 'term' | 'flair';
    term: string;
    community_id: string | null;
    community: string | null;
    posts: number;
    authors: number;
    score: number;
};

export const TOPICS = {
    MIN_AUTHORS: 3,
    MAX_TERMS: 15,
    MAX_FLAIRS: 5,
    // A word in more than this share of recent titles is too general to be a topic (checked once there are enough
    // titles for a share to mean something)
    MAX_SHARE: 0.25,
    MIN_TITLES_FOR_SHARE: 40,
    // A phrase replaces its words when it covers this share of the word's posts
    PHRASE_COVERS: 0.6,
} as const;

// English function words plus words people use in forum titles whatever the topic
const STOPWORDS = new Set(
    `a about above after again against all almost also am among an and any anybody anyone anything are aren't around as at
    be because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing
    don't down during each either else enough even ever every few for from further get gets getting got had hadn't has hasn't
    have haven't having he he'd he'll he's her here here's hers herself him himself his how how's however i i'd i'll i'm i've
    if in into is isn't it it's its itself just least less let's like likely lot lots many may me might more most much must
    mustn't my myself near need needs neither never no nor not now of off often on once one only or other others ought our
    ours ourselves out over own per please quite rather really same say says she she'd she'll she's should shouldn't since so
    some somebody someone something still such than that that's the their theirs them themselves then there there's these
    they they'd they'll they're they've thing things this those though through thus till to too towards under until up upon
    us very via was wasn't way we we'd we'll we're we've well were weren't what what's whatever when when's where where's
    whether which while who who's whom whose why why's will with within without won't would wouldn't yes yet you you'd you'll
    you're you've your yours yourself yourselves
    advice anyone ask asking best better big bit come day days does done else everyone experience find first free going good
    great guide guys help hey hi idea ideas know knows last let look looking make making new news next old part people
    post posts question questions quick real recommend recommendations right see share someone start started stop story
    sure take talk tell thanks thank think thoughts thread time times tip tips today try trying update want wants week weeks
    what's whats work year years`
        .split(/\s+/)
        .filter(Boolean)
);

const TOKEN = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu;

// Lowercased words of a title, possessives dropped. Stopwords stay in the list (as null) so phrases never jump
// over them: "price of fuel" has no phrase, "fuel price" does.
export function tokenize(title: string): (string | null)[] {
    return (title.toLowerCase().match(TOKEN) ?? []).map((raw) => {
        const word = raw.replace(/['’]s$/, '').replace(/’/g, "'");
        if (STOPWORDS.has(word)) return null;
        if (/^\d+$/.test(word)) return word.length === 4 ? word : null;
        return word.length >= 3 ? word : null;
    });
}

// A light singular form so "elections" and "election" count together
export function termKey(word: string) {
    return word.length > 4 && word.endsWith('s') && !/(ss|us|is)$/.test(word) ? word.slice(0, -1) : word;
}

type TermStats = { posts: Set<string>; authors: Set<string>; forms: Map<string, number> };

function termsOf(rows: TitleRow[]) {
    const terms = new Map<string, TermStats>();
    const add = (key: string, form: string, row: TitleRow) => {
        let stats = terms.get(key);
        if (!stats) terms.set(key, (stats = { posts: new Set(), authors: new Set(), forms: new Map() }));
        stats.posts.add(row.id);
        stats.authors.add(row.author_id);
        stats.forms.set(form, (stats.forms.get(form) ?? 0) + 1);
    };
    for (const row of rows) {
        const words = tokenize(row.title);
        words.forEach((word, index) => {
            if (!word) return;
            add(termKey(word), word, row);
            const next = words[index + 1];
            if (next) add(`${termKey(word)} ${termKey(next)}`, `${word} ${next}`, row);
        });
    }
    return terms;
}

const mostUsedForm = (forms: Map<string, number>) => [...forms].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];

export function extractTopics(
    recent: TitleRow[],
    baseline: Pick<TitleRow, 'title'>[],
    { windowDays, baselineDays }: { windowDays: number; baselineDays: number }
): Topic[] {
    if (recent.length === 0) return [];

    // How many baseline titles use each term, scaled to the length of the recent window
    const baselineDocs = new Map<string, number>();
    for (const row of baseline) {
        const words = tokenize(row.title);
        const seen = new Set<string>();
        words.forEach((word, index) => {
            if (!word) return;
            seen.add(termKey(word));
            const next = words[index + 1];
            if (next) seen.add(`${termKey(word)} ${termKey(next)}`);
        });
        for (const key of seen) baselineDocs.set(key, (baselineDocs.get(key) ?? 0) + 1);
    }
    const scale = windowDays / Math.max(baselineDays, 1);

    const candidates = [...termsOf(recent)]
        .filter(
            ([, stats]) =>
                stats.authors.size >= TOPICS.MIN_AUTHORS &&
                (recent.length < TOPICS.MIN_TITLES_FOR_SHARE || stats.posts.size / recent.length <= TOPICS.MAX_SHARE)
        )
        .map(([key, stats]) => {
            const expected = (baselineDocs.get(key) ?? 0) * scale;
            // More people beats more posts; a term that was already this common in the baseline scores low
            const score = (stats.authors.size * Math.log2(1 + stats.posts.size)) / (1 + expected);
            return { key, stats, score };
        })
        .sort((a, b) => b.score - a.score || b.stats.authors.size - a.stats.authors.size || a.key.localeCompare(b.key));

    // A phrase that covers most of its words' posts stands in for them ("super eagles", not "super" and "eagles")
    const phrases = candidates.filter((item) => item.key.includes(' '));
    const covered = new Set<string>();
    for (const phrase of phrases) {
        for (const part of phrase.key.split(' ')) {
            const word = candidates.find((item) => item.key === part);
            if (word && phrase.stats.posts.size >= word.stats.posts.size * TOPICS.PHRASE_COVERS) covered.add(part);
        }
    }

    const terms: Topic[] = candidates
        .filter((item) => !covered.has(item.key))
        .slice(0, TOPICS.MAX_TERMS)
        .map((item) => ({
            kind: 'term',
            term: mostUsedForm(item.stats.forms),
            community_id: null,
            community: null,
            posts: item.stats.posts.size,
            authors: item.stats.authors.size,
            score: Number(item.score.toFixed(4)),
        }));

    // Flairs many people are posting under right now, e.g. "Transfer news" in a football community
    const flairs = new Map<string, { row: TitleRow; posts: Set<string>; authors: Set<string> }>();
    for (const row of recent) {
        if (!row.flair) continue;
        const key = `${row.community_id}|${row.flair.toLowerCase()}`;
        const entry = flairs.get(key) ?? { row, posts: new Set(), authors: new Set() };
        entry.posts.add(row.id);
        entry.authors.add(row.author_id);
        flairs.set(key, entry);
    }
    const flairTopics: Topic[] = [...flairs.values()]
        .filter((entry) => entry.authors.size >= TOPICS.MIN_AUTHORS)
        .sort((a, b) => b.authors.size - a.authors.size || b.posts.size - a.posts.size)
        .slice(0, TOPICS.MAX_FLAIRS)
        .map((entry) => ({
            kind: 'flair',
            term: entry.row.flair!,
            community_id: entry.row.community_id,
            community: entry.row.community,
            posts: entry.posts.size,
            authors: entry.authors.size,
            score: entry.authors.size * Math.log2(1 + entry.posts.size),
        }));

    return [...terms, ...flairTopics];
}
