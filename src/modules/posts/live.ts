import { Prisma, User } from '@prisma/client';
import prisma from '../../prismaConnection';
import { badRequest } from '../../lib/http';
import { postInclude } from '../../lib/serializers';
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

// How many live threads one account may run at once (site admins aren't limited), so one account can't fill the
// home page's "Live now" box
export const LIVE_PER_ACCOUNT = 2;

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

// Starts or ends a live thread once the caller has checked who may. Starting again after an end picks the same thread
// up again. The running-threads cap counts against the post's author, whoever presses the switch; site admins' own
// threads aren't limited.
export async function switchLive(post: LiveFields & { id: string; author_id: string }, live: boolean) {
    if (live && post.status !== 'active') throw badRequest('Only open, visible posts can go live.', 'post_unavailable');
    if (live && !isLive(post)) {
        const author = await prisma.user.findUniqueOrThrow({ where: { id: post.author_id }, select: { role: true } });
        const running = author.role === 'admin' ? 0 : await prisma.post.count({ where: { AND: [liveWhere(), { author_id: post.author_id }] } });
        if (running >= LIVE_PER_ACCOUNT) {
            throw badRequest(`An account can run ${LIVE_PER_ACCOUNT} live threads at a time. End one of them first.`, 'live_limit');
        }
    }
    return prisma.post.update({
        where: { id: post.id },
        data: live ? { live_started_at: new Date(), live_ended_at: null } : { live_ended_at: post.live_started_at ? new Date() : null },
        include: postInclude,
    });
}
