import { Prisma, ReportTargetType } from '@prisma/client';
import prisma from '../../prismaConnection';
import { commentInclude, postInclude, toPublicComment, toPublicPost } from '../../lib/serializers';
import { ViewerContext } from '../communities/access';

// The mod queue: everything waiting for a moderator in one list. An item is a post, comment, user, community or ad
// with open reports and/or held by the automatic filters. Reports on the same target are grouped.

const QUEUE_LIMIT = 100;

// site: what needs the site's admins (held for them, site-rule, escalated, or about users/communities/ads);
// allReports: every open report in every community, for the admin panel's Reports tab (no held items)
type Scope = { communityId: string } | { site: true; allReports?: boolean };

// reasons: site rules by reason code; rules: community rules by title; site: how many of the reports name a site rule
type ReportSummary = {
    total: number;
    site: number;
    reasons: Record<string, number>;
    rules: Record<string, number>;
    notes: { note: string; reporter: string; created_at: Date }[];
};

type Escalation = { at: Date; by: string | null; note: string | null };

export type QueueItem = {
    target_type: ReportTargetType;
    target_id: string;
    // Newest report or hold, for ordering
    updated_at: Date;
    held_reason: string | null;
    reports: ReportSummary;
    report_ids: string[];
    // Sent on to the site's admins by a community moderator
    escalation: Escalation | null;
    post?: ReturnType<typeof toPublicPost>;
    comment?: ReturnType<typeof toPublicComment> & { post: { short_id: string; slug: string; title: string; community: string } };
    user?: { username: string; status: string; karma: number; created_at: Date };
    community?: { name: string; display_name: string | null; status: string };
    ad?: { headline: string; advertiser: string; campaign_id: string; campaign: string; is_active: boolean };
};

// Reports the site's admins act on: site-level targets, site-rule reports and escalations. Community-rule reports are
// for the community's moderators, as on Reddit.
export const FOR_ADMINS: Prisma.ReportWhereInput = { OR: [{ community_id: null }, { rule_kind: 'site' }, { escalated_at: { not: null } }] };

// Community queues see every report filed against that community's content; the site queue sees what needs admins
const reportWhere = (scope: Scope): Prisma.ReportWhereInput =>
    'communityId' in scope
        ? { status: 'open', community_id: scope.communityId }
        : scope.allReports
          ? { status: 'open' }
          : { status: 'open', ...FOR_ADMINS };

// Held for the site's admins: only the site queue lists it. The all-reports view lists reports only.
const heldFilter = (scope: Scope) => ('communityId' in scope ? { held_for_admins: false } : {});
const withHeld = (scope: Scope) => !('allReports' in scope && scope.allReports);

export async function queueCount(scope: Scope) {
    const communityFilter = 'communityId' in scope ? { community_id: scope.communityId } : {};
    const [reports, posts, comments] = await Promise.all([
        prisma.report.findMany({ where: reportWhere(scope), distinct: ['target_type', 'target_id'], select: { id: true } }),
        withHeld(scope) ? prisma.post.count({ where: { status: 'pending', ...heldFilter(scope), ...communityFilter } }) : 0,
        withHeld(scope) ? prisma.comment.count({ where: { status: 'pending', ...heldFilter(scope), post: communityFilter } }) : 0,
    ]);
    return reports.length + posts + comments;
}

export async function buildQueue(scope: Scope, context: ViewerContext): Promise<QueueItem[]> {
    const communityFilter = 'communityId' in scope ? { community_id: scope.communityId } : {};
    const held = async <T>(query: () => Promise<T[]>) => (withHeld(scope) ? query() : []);
    const [reports, heldPosts, heldComments] = await Promise.all([
        prisma.report.findMany({
            where: reportWhere(scope),
            orderBy: { created_at: 'desc' },
            take: 500,
            select: {
                id: true,
                created_at: true,
                target_type: true,
                target_id: true,
                reason_code: true,
                rule_kind: true,
                rule_title: true,
                note: true,
                escalated_at: true,
                escalation_note: true,
                reporter: { select: { username: true } },
                escalator: { select: { username: true } },
            },
        }),
        held(() =>
            prisma.post.findMany({
                where: { status: 'pending', ...heldFilter(scope), ...communityFilter },
                orderBy: { created_at: 'desc' },
                take: QUEUE_LIMIT,
                select: { id: true, created_at: true, held_reason: true },
            })
        ),
        held(() =>
            prisma.comment.findMany({
                where: { status: 'pending', ...heldFilter(scope), post: communityFilter },
                orderBy: { created_at: 'desc' },
                take: QUEUE_LIMIT,
                select: { id: true, created_at: true, held_reason: true },
            })
        ),
    ]);

    const items = new Map<string, QueueItem>();
    const itemFor = (target_type: ReportTargetType, target_id: string, at: Date) => {
        const key = `${target_type}:${target_id}`;
        let item = items.get(key);
        if (!item) {
            item = {
                target_type,
                target_id,
                updated_at: at,
                held_reason: null,
                reports: { total: 0, site: 0, reasons: {}, rules: {}, notes: [] },
                report_ids: [],
                escalation: null,
            };
            items.set(key, item);
        }
        if (at > item.updated_at) item.updated_at = at;
        return item;
    };

    for (const report of reports) {
        const item = itemFor(report.target_type, report.target_id, report.created_at);
        item.reports.total += 1;
        if (report.rule_kind === 'community' && report.rule_title) {
            item.reports.rules[report.rule_title] = (item.reports.rules[report.rule_title] ?? 0) + 1;
        } else {
            item.reports.site += 1;
            item.reports.reasons[report.reason_code] = (item.reports.reasons[report.reason_code] ?? 0) + 1;
        }
        if (report.escalated_at && (!item.escalation || report.escalated_at < item.escalation.at)) {
            item.escalation = { at: report.escalated_at, by: report.escalator?.username ?? null, note: report.escalation_note };
        }
        item.report_ids.push(report.id);
        if (report.note && item.reports.notes.length < 5) {
            item.reports.notes.push({ note: report.note, reporter: report.reporter.username, created_at: report.created_at });
        }
    }
    for (const post of heldPosts) itemFor('post', post.id, post.created_at).held_reason = post.held_reason ?? 'Held for review';
    for (const comment of heldComments) itemFor('comment', comment.id, comment.created_at).held_reason = comment.held_reason ?? 'Held for review';

    const ordered = [...items.values()].sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime()).slice(0, QUEUE_LIMIT);
    const idsOf = (type: ReportTargetType) => ordered.filter((item) => item.target_type === type).map((item) => item.target_id);

    const [posts, comments, users, communities, ads] = await Promise.all([
        prisma.post.findMany({ where: { id: { in: idsOf('post') } }, include: postInclude }),
        prisma.comment.findMany({
            where: { id: { in: idsOf('comment') } },
            include: { ...commentInclude, post: { select: { community_id: true, short_id: true, slug: true, title: true, community: { select: { name: true } } } } },
        }),
        prisma.user.findMany({
            where: { id: { in: idsOf('user') } },
            select: { id: true, username: true, status: true, karma: true, created_at: true },
        }),
        prisma.community.findMany({ where: { id: { in: idsOf('community') } }, select: { id: true, name: true, display_name: true, status: true } }),
        prisma.adCreative.findMany({
            where: { id: { in: idsOf('ad') } },
            select: { id: true, headline: true, is_active: true, campaign: { select: { id: true, name: true, advertiser: { select: { name: true } } } } },
        }),
    ]);
    const postsById = new Map(posts.map((row) => [row.id, row]));
    const commentsById = new Map(comments.map((row) => [row.id, row]));
    const usersById = new Map(users.map((row) => [row.id, row]));
    const communitiesById = new Map(communities.map((row) => [row.id, row]));
    const adsById = new Map(ads.map((row) => [row.id, row]));

    // Content that has since gone (deleted by its author, cascade-deleted) drops out
    return ordered.flatMap((item): QueueItem[] => {
        if (item.target_type === 'post') {
            const post = postsById.get(item.target_id);
            return post ? [{ ...item, post: toPublicPost(post, context) }] : [];
        }
        if (item.target_type === 'comment') {
            const comment = commentsById.get(item.target_id);
            if (!comment) return [];
            const { post } = comment;
            return [
                {
                    ...item,
                    comment: {
                        ...toPublicComment(comment, post.community_id, context),
                        post: { short_id: post.short_id, slug: post.slug, title: post.title, community: post.community.name },
                    },
                },
            ];
        }
        if (item.target_type === 'user') {
            const user = usersById.get(item.target_id);
            return user ? [{ ...item, user: { username: user.username, status: user.status, karma: user.karma, created_at: user.created_at } }] : [];
        }
        if (item.target_type === 'ad') {
            const ad = adsById.get(item.target_id);
            if (!ad) return [];
            return [
                {
                    ...item,
                    ad: { headline: ad.headline, advertiser: ad.campaign.advertiser.name, campaign_id: ad.campaign.id, campaign: ad.campaign.name, is_active: ad.is_active },
                },
            ];
        }
        const community = communitiesById.get(item.target_id);
        return community ? [{ ...item, community: { name: community.name, display_name: community.display_name, status: community.status } }] : [];
    });
}

// Moderator decisions close the open reports on what they decided about: removing upholds them, approving
// dismisses them
export async function closeReports(targetType: ReportTargetType, targetId: string, status: 'resolved' | 'dismissed', actor: string | Actor) {
    const by = typeof actor === 'string' ? { resolved_by: actor } : 'staffId' in actor ? { resolved_by_staff: actor.staffId } : { resolved_by: actor.userId };
    return prisma.report.updateMany({
        where: { target_type: targetType, target_id: targetId, status: 'open' },
        data: { status, ...by, resolved_at: new Date() },
    });
}

// Who made a moderation decision: a forum moderator, or a staff member from the admin panel
export type Actor = { userId: string } | { staffId: string };
export const actorFields = (actor: Actor) => ('staffId' in actor ? { staff_id: actor.staffId } : { actor_id: actor.userId });
