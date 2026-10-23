import { Router } from 'express';
import { User } from '@prisma/client';
import { z } from 'zod';
import prisma from '../../prismaConnection';
import { afterCursor, decodeCursor, paginate } from '../../lib/cursor';
import { badRequest, forbidden, notFound, parse, uuidParam } from '../../lib/http';
import { postInclude, toPublicComment, toPublicPost } from '../../lib/serializers';
import { AuthRequest, requireAuth, viewerOf } from '../../middlewares/auth';
import { LIMITS, pageQuery } from '../../shared/validation';
import { setCommentStatus } from '../comments/service';
import { findVisibleComment } from '../comments/routes';
import { assertModerator, findCommunity, viewerContext } from '../communities/access';
import { findVisiblePost } from '../posts/service';

// Reports, the mod queue, moderator actions on posts and comments, and the mod log.
// Every action writes a ModAction row, which is the audit trail.

const router = Router();

const reason = z.string().trim().max(LIMITS.REASON_MAX).optional();

const reportSchema = z.object({
    target_type: z.enum(['post', 'comment', 'user', 'community']),
    target_id: z.uuid(),
    reason_code: z.enum([
        'spam', 'harassment', 'hate', 'violence', 'sexual', 'self_harm', 'misinformation', 'illegal', 'impersonation', 'other',
    ]),
    note: z.string().trim().max(LIMITS.REPORT_NOTE_MAX).optional(),
});

const resolveSchema = z.object({ status: z.enum(['resolved', 'dismissed']) });

const postActionSchema = z.object({
    action: z.enum(['remove', 'approve', 'lock', 'unlock', 'pin', 'unpin', 'sponsor', 'unsponsor']),
    reason,
});

const commentActionSchema = z.object({ action: z.enum(['remove', 'approve', 'lock', 'unlock', 'pin', 'unpin']), reason });

const reportsQuery = pageQuery.extend({ status: z.enum(['open', 'resolved', 'dismissed']).default('open') });

const requireAdmin = (user: User) => {
    if (user.role !== 'admin') throw forbidden('Only site admins can do that.', 'not_admin');
};

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

// Site-level reports (users and communities)
router.get('/admin/reports', requireAuth, async (request: AuthRequest, response) => {
    requireAdmin(viewerOf(request).user);
    const { items, next_cursor } = await listReports({ community_id: null }, parse(reportsQuery, request.query));
    response.json({ reports: items, next_cursor });
});

// Closes a report and every other open report on the same target
router.post('/reports/:id/resolve', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const { status } = parse(resolveSchema, request.body);
    const report = await prisma.report.findUnique({ where: { id: uuidParam(request.params.id, 'Report not found') } });
    if (!report) throw notFound('Report not found');
    if (report.community_id) await assertModerator(report.community_id, user);
    else requireAdmin(user);

    const result = await prisma.report.updateMany({
        where: { target_type: report.target_type, target_id: report.target_id, status: 'open' },
        data: { status, resolved_by: user.id, resolved_at: new Date() },
    });
    await prisma.modAction.create({
        data: {
            actor_id: user.id,
            community_id: report.community_id,
            action: status === 'resolved' ? 'resolve_reports' : 'dismiss_reports',
            target_type: report.target_type,
            target_id: report.target_id,
            details: { count: result.count },
        },
    });
    response.json({ success: true, closed: result.count });
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

    if (input.action === 'sponsor' || input.action === 'unsponsor') requireAdmin(user);
    else await assertModerator(post.community_id, user);
    if (post.status === 'deleted') throw badRequest('The author deleted this post.', 'post_deleted');

    const data = (() => {
        switch (input.action) {
            case 'remove':
                return { status: 'removed' as const, pinned_at: null };
            case 'approve':
                return { status: 'active' as const };
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
    const countChange = (counted(nextStatus) ? 1 : 0) - (counted(post.status) ? 1 : 0);

    const [updated] = await prisma.$transaction([
        prisma.post.update({ where: { id: post.id }, data, include: postInclude }),
        ...(countChange !== 0
            ? [prisma.community.update({ where: { id: post.community_id }, data: { post_count: { increment: countChange } } })]
            : []),
        prisma.modAction.create({
            data: {
                actor_id: user.id,
                community_id: post.community_id,
                action: `${input.action}_post`,
                target_type: 'post',
                target_id: post.id,
                reason: input.reason ?? null,
            },
        }),
    ]);
    response.json({ post: toPublicPost(updated as typeof updated & { community: typeof post.community }, context) });
});

router.post('/comments/:id/moderation', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const input = parse(commentActionSchema, request.body);
    const context = await viewerContext(request.viewer);
    const comment = await findVisibleComment(String(request.params.id), user, context);
    const communityId = comment.post.community_id;
    await assertModerator(communityId, user);
    if (comment.status === 'deleted') throw badRequest('The author deleted this comment.', 'comment_deleted');
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
            updated = await setCommentStatus(comment, 'active');
            break;
        case 'lock':
            updated = await setCommentStatus(comment, 'locked');
            break;
        case 'pin':
        case 'unpin':
            updated = await prisma.comment.update({
                where: { id: comment.id },
                data: { pinned_at: input.action === 'pin' ? new Date() : null },
                include: { author: { select: { username: true, display_name: true, avatar_id: true, status: true } } },
            });
            break;
    }
    await prisma.modAction.create({
        data: {
            actor_id: user.id,
            community_id: communityId,
            action: `${input.action}_comment`,
            target_type: 'comment',
            target_id: comment.id,
            reason: input.reason ?? null,
        },
    });
    response.json({ comment: toPublicComment(updated, communityId, context) });
});

export default router;
