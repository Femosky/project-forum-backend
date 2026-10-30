import { Router } from 'express';
import { Report } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../prismaConnection';
import { afterCursor, decodeCursor, paginate } from '../../lib/cursor';
import { badRequest, forbidden, notFound, parse, uuidParam } from '../../lib/http';
import { authorSelect, postInclude, toPublicComment, toPublicPost } from '../../lib/serializers';
import { AuthRequest, requireAuth, viewerOf } from '../../middlewares/auth';
import { LIMITS, pageQuery, username } from '../../shared/validation';
import { setCommentStatus } from '../comments/service';
import { findVisibleComment } from '../comments/routes';
import { assertFullModerator, assertModerator, findCommunity, findMembership, ViewerContext, viewerContext } from '../communities/access';
import { findVisiblePost } from '../posts/service';
import { alertModerators } from './alerts';
import { Actor, actorFields, buildQueue, closeReports } from './queue';

// Reports, the mod queue, moderator actions on posts and comments, mutes, and the mod log.
// Every action writes a ModAction row, which is the audit trail.

const router = Router();

const reason = z.string().trim().max(LIMITS.REASON_MAX).optional();

// The roadmap's reasons first; the rest are kept for reports filed before Phase 5
export const REPORT_REASONS = [
    'spam', 'scam', 'harassment', 'hate', 'sexual', 'violence', 'misinformation', 'personal_info', 'other',
    'self_harm', 'illegal', 'impersonation',
] as const;

const muteSchema = z.object({
    username,
    days: z.number().int().min(1).max(365),
    reason,
});

const reportSchema = z.object({
    target_type: z.enum(['post', 'comment', 'user', 'community', 'ad']),
    target_id: z.uuid(),
    reason_code: z.enum(REPORT_REASONS),
    note: z.string().trim().max(LIMITS.REPORT_NOTE_MAX).optional(),
});

export const postActionSchema = z.object({
    action: z.enum(['remove', 'approve', 'lock', 'unlock', 'pin', 'unpin', 'sponsor', 'unsponsor']),
    reason,
});

export const commentActionSchema = z.object({ action: z.enum(['remove', 'approve', 'lock', 'unlock', 'pin', 'unpin']), reason });

const reportsQuery = pageQuery.extend({ status: z.enum(['open', 'resolved', 'dismissed']).default('open') });

// Which community's moderators should see a report (null: site admins)
async function reportCommunity(targetType: string, targetId: string) {
    if (targetType === 'post') {
        const post = await prisma.post.findUnique({ where: { id: targetId }, select: { community_id: true } });
        if (!post) throw notFound('Post not found');
        return post.community_id;
    }
    if (targetType === 'comment') {
        const comment = await prisma.comment.findUnique({ where: { id: targetId }, select: { post: { select: { community_id: true } } } });
        if (!comment) throw notFound('Comment not found');
        return comment.post.community_id;
    }
    if (targetType === 'user') {
        if (!(await prisma.user.findUnique({ where: { id: targetId }, select: { id: true } }))) throw notFound('User not found');
        return null;
    }
    if (targetType === 'ad') {
        if (!(await prisma.adCreative.findUnique({ where: { id: targetId }, select: { id: true } }))) throw notFound('Ad not found');
        return null;
    }
    if (!(await prisma.community.findUnique({ where: { id: targetId }, select: { id: true } }))) throw notFound('Community not found');
    return null;
}

router.post('/reports', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const input = parse(reportSchema, request.body);
    const communityId = await reportCommunity(input.target_type, input.target_id);

    // Reporting the same thing twice just updates the first report
    await prisma.report.upsert({
        where: { reporter_id_target_type_target_id: { reporter_id: user.id, target_type: input.target_type, target_id: input.target_id } },
        create: {
            reporter_id: user.id,
            target_type: input.target_type,
            target_id: input.target_id,
            community_id: communityId,
            reason_code: input.reason_code,
            note: input.note ?? null,
        },
        update: { reason_code: input.reason_code, note: input.note ?? null },
    });
    if (communityId) alertModerators(communityId, 'mod_report');
    response.status(201).json({ success: true });
});

async function listReports(where: { community_id: string | null }, query: z.infer<typeof reportsQuery>) {
    const rows = await prisma.report.findMany({
        where: { AND: [{ ...where, status: query.status }, afterCursor('created_at', 'desc', decodeCursor(query.cursor))] },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        select: {
            id: true,
            created_at: true,
            target_type: true,
            target_id: true,
            reason_code: true,
            note: true,
            status: true,
            resolved_at: true,
            reporter: { select: { username: true } },
        },
    });
    return paginate(rows, query.limit, 'created_at');
}

router.get('/communities/:name/reports', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    await assertModerator(community.id, user);
    const { items, next_cursor } = await listReports({ community_id: community.id }, parse(reportsQuery, request.query));
    response.json({ reports: items, next_cursor });
});

// Closes a report and every other open report on the same target. Site-level reports (users, communities, ads) are
// for staff, from the admin panel (POST /v1/admin/reports/:id/resolve).
router.post('/reports/:id/resolve', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const { status } = parse(resolveSchema, request.body);
    const report = await prisma.report.findUnique({ where: { id: uuidParam(request.params.id, 'Report not found') } });
    if (!report) throw notFound('Report not found');
    if (!report.community_id) throw forbidden('Only site staff can close this report.', 'not_admin');
    await assertModerator(report.community_id, user);
    response.json({ success: true, closed: await resolveReport(report, status, { userId: user.id }) });
});

export const resolveSchema = z.object({ status: z.enum(['resolved', 'dismissed']) });

export async function resolveReport(report: Report, status: 'resolved' | 'dismissed', actor: Actor) {
    const result = await closeReports(report.target_type, report.target_id, status, actor);
    await prisma.modAction.create({
        data: {
            ...actorFields(actor),
            community_id: report.community_id,
            action: status === 'resolved' ? 'resolve_reports' : 'dismiss_reports',
            target_type: report.target_type,
            target_id: report.target_id,
            details: { count: result.count },
        },
    });
    return result.count;
}

// Reports and held items waiting for this community's moderators
router.get('/communities/:name/mod-queue', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    await assertModerator(community.id, user);
    const items = await buildQueue({ communityId: community.id }, await viewerContext(request.viewer));
    response.json({ items });
});

// Who is banned or muted here
router.get('/communities/:name/restrictions', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    await assertModerator(community.id, user);
    const now = new Date();
    const [bans, mutes] = await Promise.all([
        prisma.communityMember.findMany({
            where: { community_id: community.id, is_banned: true, OR: [{ banned_until: null }, { banned_until: { gt: now } }] },
            select: { banned_until: true, ban_reason: true, user: { select: { username: true } } },
            take: 200,
        }),
        prisma.communityMute.findMany({
            where: { community_id: community.id, muted_until: { gt: now } },
            select: { muted_until: true, reason: true, user: { select: { username: true } } },
            take: 200,
        }),
    ]);
    response.json({
        bans: bans.map((row) => ({ username: row.user.username, until: row.banned_until, reason: row.ban_reason })),
        mutes: mutes.map((row) => ({ username: row.user.username, until: row.muted_until, reason: row.reason })),
    });
});

// A mute stops someone posting and commenting here for a while; they can still read and stay a member
router.post('/communities/:name/mutes', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    const actor = await assertFullModerator(community.id, user);
    const input = parse(muteSchema, request.body);

    const target = await prisma.user.findUnique({ where: { username: input.username } });
    if (!target) throw notFound('User not found');
    if (target.id === user.id) throw badRequest("You can't mute yourself.", 'self_mute');
    const member = await findMembership(community.id, target.id);
    if (member?.role === 'owner') throw forbidden("The owner can't be muted.", 'cannot_mute_owner');
    if (member?.role === 'moderator' && actor && actor.role !== 'owner') {
        throw forbidden('Only the owner can mute a moderator.', 'cannot_mute_moderator');
    }

    const until = new Date(Date.now() + input.days * 24 * 60 * 60 * 1000);
    await prisma.$transaction([
        prisma.communityMute.upsert({
            where: { community_id_user_id: { community_id: community.id, user_id: target.id } },
            create: { community_id: community.id, user_id: target.id, muted_until: until, reason: input.reason ?? null, muted_by: user.id },
            update: { muted_until: until, reason: input.reason ?? null, muted_by: user.id },
        }),
        prisma.modAction.create({
            data: {
                actor_id: user.id,
                community_id: community.id,
                action: 'mute_user',
                target_type: 'user',
                target_id: target.id,
                reason: input.reason ?? null,
                details: { until: until.toISOString() },
            },
        }),
    ]);
    response.json({ username: target.username, muted_until: until });
});

router.delete('/communities/:name/mutes/:username', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    await assertFullModerator(community.id, user);
    const target = await prisma.user.findUnique({ where: { username: String(request.params.username).toLowerCase() } });
    const result = target
        ? await prisma.communityMute.deleteMany({ where: { community_id: community.id, user_id: target.id } })
        : { count: 0 };
    if (!target || result.count === 0) throw notFound('That user is not muted here.', 'not_muted');
    await prisma.modAction.create({
        data: { actor_id: user.id, community_id: community.id, action: 'unmute_user', target_type: 'user', target_id: target.id },
    });
    response.json({ success: true });
});

router.get('/communities/:name/mod-log', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const community = await findCommunity(String(request.params.name));
    await assertModerator(community.id, user);
    const query = parse(pageQuery, request.query);
    const rows = await prisma.modAction.findMany({
        where: { AND: [{ community_id: community.id }, afterCursor('created_at', 'desc', decodeCursor(query.cursor))] },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        select: {
            id: true,
            created_at: true,
            action: true,
            target_type: true,
            target_id: true,
            reason: true,
            details: true,
            actor: { select: { username: true } },
        },
    });
    const { items, next_cursor } = paginate(rows, query.limit, 'created_at');
    response.json({ actions: items, next_cursor });
});

const counted = (status: string) => status === 'active' || status === 'locked';

router.post('/posts/:id/moderation', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const input = parse(postActionSchema, request.body);
    const context = await viewerContext(request.viewer);
    const post = await findVisiblePost(String(request.params.id), user, context);

    // Marking posts as sponsored is for staff (the admin panel)
    if (input.action === 'sponsor' || input.action === 'unsponsor') throw forbidden('Only site staff can do that.', 'not_admin');
    await assertModerator(post.community_id, user);
    response.json({ post: await moderatePost(post, input, { userId: user.id }, context) });
});

type PostForModeration = Awaited<ReturnType<typeof findVisiblePost>>;

// Content held for the site's admins (sexual content, or worse) can only be removed by a community's moderators;
// publishing it is the admin team's call, from the admin panel
function assertCanClearHold(item: { held_for_admins: boolean; status: string }, action: string, actor: Actor) {
    if (item.held_for_admins && item.status === 'pending' && action !== 'remove' && !('staffId' in actor)) {
        throw forbidden("Only the site's admins can decide on this one. You can remove it.", 'held_for_admins');
    }
}

// A moderator's or staff member's decision on a post, with the community's post count, the log and its reports
export async function moderatePost(post: PostForModeration, input: z.infer<typeof postActionSchema>, actor: Actor, context: ViewerContext) {
    if (post.status === 'deleted') throw badRequest('The author deleted this post.', 'post_deleted');
    assertCanClearHold(post, input.action, actor);

    const data = (() => {
        switch (input.action) {
            case 'remove':
                return { status: 'removed' as const, pinned_at: null };
            case 'approve':
                return { status: 'active' as const, held_for_admins: false };
            case 'lock':
                return { status: 'locked' as const };
            case 'unlock':
                return { status: 'active' as const };
            case 'pin':
                return { pinned_at: new Date() };
            case 'unpin':
                return { pinned_at: null };
            case 'sponsor':
                return { is_sponsored: true };
            case 'unsponsor':
                return { is_sponsored: false };
        }
    })();
    if (input.action === 'pin' && !counted(post.status)) throw badRequest('Only visible posts can be pinned.', 'not_visible');
    if (input.action === 'unlock' && post.status !== 'locked') throw badRequest('This post is not locked.', 'not_locked');

    const nextStatus = (data as { status?: string }).status ?? post.status;
    const countChange = post.shadow_hidden ? 0 : (counted(nextStatus) ? 1 : 0) - (counted(post.status) ? 1 : 0);

    const [updated] = await prisma.$transaction([
        prisma.post.update({ where: { id: post.id }, data, include: postInclude }),
        ...(countChange !== 0
            ? [prisma.community.update({ where: { id: post.community_id }, data: { post_count: { increment: countChange } } })]
            : []),
        prisma.modAction.create({
            data: {
                ...actorFields(actor),
                community_id: post.community_id,
                action: `${input.action}_post`,
                target_type: 'post',
                target_id: post.id,
                reason: input.reason ?? null,
                ...(post.held_reason && input.action === 'approve' ? { details: { held_reason: post.held_reason } } : {}),
            },
        }),
    ]);
    if (input.action === 'remove') await closeReports('post', post.id, 'resolved', actor);
    if (input.action === 'approve') await closeReports('post', post.id, 'dismissed', actor);
    return toPublicPost(updated as typeof updated & { community: typeof post.community }, context);
}

router.post('/comments/:id/moderation', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const input = parse(commentActionSchema, request.body);
    const context = await viewerContext(request.viewer);
    const comment = await findVisibleComment(String(request.params.id), user, context);
    await assertModerator(comment.post.community_id, user);
    response.json({ comment: await moderateComment(comment, input, { userId: user.id }, context) });
});

type CommentForModeration = Awaited<ReturnType<typeof findVisibleComment>>;

export async function moderateComment(comment: CommentForModeration, input: z.infer<typeof commentActionSchema>, actor: Actor, context: ViewerContext) {
    const communityId = comment.post.community_id;
    if (comment.status === 'deleted') throw badRequest('The author deleted this comment.', 'comment_deleted');
    assertCanClearHold(comment, input.action, actor);
    if ((input.action === 'pin' || input.action === 'unpin') && comment.depth !== 0) {
        throw badRequest('Only top-level comments can be pinned.', 'not_top_level');
    }

    let updated: Awaited<ReturnType<typeof setCommentStatus>>;
    switch (input.action) {
        case 'remove':
            updated = await setCommentStatus(comment, 'removed', { pinned_at: null });
            break;
        case 'approve':
        case 'unlock':
            updated = await setCommentStatus(comment, 'active', { held_for_admins: false });
            break;
        case 'lock':
            updated = await setCommentStatus(comment, 'locked');
            break;
        case 'pin':
        case 'unpin':
            updated = await prisma.comment.update({
                where: { id: comment.id },
                data: { pinned_at: input.action === 'pin' ? new Date() : null },
                include: { author: { select: authorSelect } },
            });
            break;
    }
    await prisma.modAction.create({
        data: {
            ...actorFields(actor),
            community_id: communityId,
            action: `${input.action}_comment`,
            target_type: 'comment',
            target_id: comment.id,
            reason: input.reason ?? null,
        },
    });
    if (input.action === 'remove') await closeReports('comment', comment.id, 'resolved', actor);
    if (input.action === 'approve') await closeReports('comment', comment.id, 'dismissed', actor);
    return toPublicComment(updated, communityId, context);
}

export default router;
