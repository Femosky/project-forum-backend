// Reddit-style ranking. Kept in one place so the API, the seed script and tests agree.

const EPOCH_OFFSET = 1134028003; // seconds; keeps hot ranks small

// How much one visible comment counts in the hot rank, against one net vote
export const HOT_COMMENT_WEIGHT = 0.5;

// Hot rank grows by 1 every 12.5 hours and by 1 for every 10x more engagement. Engagement is net votes plus half
// the visible comment count, so a thread people are replying to rises even when nobody votes. No decay job is
// needed: newer posts simply start higher. The migration's forum_hot_rank() SQL function is the same formula,
// for recomputing in the database when comments come and go (a test keeps the two in step).
export function hotRank(score: number, createdAt: Date, commentCount = 0): number {
    const engagement = score + HOT_COMMENT_WEIGHT * commentCount;
    const order = Math.log10(Math.max(Math.abs(engagement), 1));
    const sign = engagement > 0 ? 1 : engagement < 0 ? -1 : 0;
    const seconds = createdAt.getTime() / 1000 - EPOCH_OFFSET;
    return Number((sign * order + seconds / 45000).toFixed(7));
}

// Lower bound of the Wilson score interval (80% confidence): the "best" comment sort
export function wilsonLowerBound(upvotes: number, downvotes: number): number {
    const n = upvotes + downvotes;
    if (n === 0) return 0;
    const z = 1.281551565545;
    const p = upvotes / n;
    const left = p + (z * z) / (2 * n);
    const right = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    return (left - right) / (1 + (z * z) / n);
}

export const TOP_WINDOWS = {
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000,
    all: null,
} as const;

export type TopWindow = keyof typeof TOP_WINDOWS;

export function topWindowStart(window: TopWindow): Date | undefined {
    const span = TOP_WINDOWS[window];
    return span === null ? undefined : new Date(Date.now() - span);
}
