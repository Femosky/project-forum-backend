import { Prisma, User } from '@prisma/client';
import { canModerate, ViewerContext } from '../communities/access';

// Live threads (match days, events). A post is live from live_started_at until live_ended_at, and never longer
// than this, so a thread nobody remembered to end stops showing "Live" by itself.
export const LIVE_MAX_HOURS = 36;
const LIVE_MAX_MS = LIVE_MAX_HOURS * 60 * 60 * 1000;

type LiveFields = { status: string; live_started_at: Date | null; live_ended_at: Date | null };

export function isLive(post: LiveFields, now = Date.now()) {
    return (
        post.status === 'active' &&
        post.live_started_at !== null &&
        post.live_ended_at === null &&
        now - post.live_started_at.getTime() < LIVE_MAX_MS
    );
}

// When the live coverage ended (or will end by itself), for the page and the LiveBlogPosting markup
export function liveEndsAt(post: LiveFields) {
    if (!post.live_started_at) return null;
    return post.live_ended_at ?? new Date(post.live_started_at.getTime() + LIVE_MAX_MS);
}

// What the API sends: null for posts that were never live
export function publicLive(post: LiveFields) {
    if (!post.live_started_at) return null;
    const live = isLive(post);
    return { is_live: live, started_at: post.live_started_at, ended_at: live ? null : liveEndsAt(post) };
}

// Posts that are live right now (status is filtered by the caller's list query)
export function liveWhere(now = new Date()): Prisma.PostWhereInput {
    return { live_started_at: { gt: new Date(now.getTime() - LIVE_MAX_MS) }, live_ended_at: null, status: 'active' };
}

// Who may start or end a live thread: the community's moderators and the site's admins on any post there, and the
// author when the site trusts them (trusted, staff-run or admin accounts). Live threads lead their community and the
// home page, so a brand-new account can't put itself there.
export function canSetLive(post: { author_id: string; community_id: string }, user: Pick<User, 'id' | 'is_trusted' | 'is_seed' | 'role'>, context: ViewerContext) {
    if (canModerate(context, post.community_id)) return true;
    return post.author_id === user.id && (user.is_trusted || user.is_seed || user.role === 'admin');
}
