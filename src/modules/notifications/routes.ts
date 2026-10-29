import { Router } from 'express';
import { avatarCode } from '../../lib/avatars';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../../prismaConnection';
import { afterCursor, decodeCursor, paginate } from '../../lib/cursor';
import { parse } from '../../lib/http';
import { READABLE_POST_WHERE } from '../../lib/serializers';
import { AuthRequest, requireAuth, viewerOf } from '../../middlewares/auth';
import { pageQuery } from '../../shared/validation';

const router = Router();

const readSchema = z.object({ ids: z.array(z.uuid()).max(100).optional() });

const EXCERPT_LENGTH = 200;

// Only notifications whose comment and post are still there to read
const visible = {
    comment: { status: { in: ['active', 'locked'] } },
    post: READABLE_POST_WHERE,
} satisfies Prisma.NotificationWhereInput;

const include = {
    actor: { select: { username: true, display_name: true, avatar_id: true, avatar_config: true, status: true } },
    comment: { select: { short_id: true, body: true, is_anonymous: true } },
    post: { select: { short_id: true, slug: true, title: true, community: { select: { name: true } } } },
} satisfies Prisma.NotificationInclude;

type NotificationRow = Prisma.NotificationGetPayload<{ include: typeof include }>;

function toPublicNotification(row: NotificationRow) {
    const showActor = row.actor && !row.comment.is_anonymous && row.actor.status !== 'deleted';
    return {
        id: row.id,
        type: row.type,
        created_at: row.created_at,
        read_at: row.read_at,
        actor: showActor
            ? { username: row.actor!.username, display_name: row.actor!.display_name, avatar_id: row.actor!.avatar_id, avatar: avatarCode(row.actor!.avatar_config) }
            : null,
        post: { short_id: row.post.short_id, slug: row.post.slug, title: row.post.title, community: row.post.community.name },
        comment: { short_id: row.comment.short_id, excerpt: row.comment.body.slice(0, EXCERPT_LENGTH) },
    };
}

const unreadCount = (userId: string) => prisma.notification.count({ where: { user_id: userId, read_at: null, ...visible } });

router.get('/', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const query = parse(pageQuery, request.query);
    const rows = await prisma.notification.findMany({
        where: { AND: [{ user_id: user.id, ...visible }, afterCursor('created_at', 'desc', decodeCursor(query.cursor))] },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        include,
    });
    const { items, next_cursor } = paginate(rows, query.limit, 'created_at');
    response.json({ notifications: items.map(toPublicNotification), next_cursor, unread_count: await unreadCount(user.id) });
});

// Polled by the bell in the header, so it stays a single indexed count
router.get('/unread-count', requireAuth, async (request: AuthRequest, response) => {
    response.json({ count: await unreadCount(viewerOf(request).user.id) });
});

// Marks the given notifications read, or all of them when no ids are sent
router.post('/read', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const { ids } = parse(readSchema, request.body);
    await prisma.notification.updateMany({
        where: { user_id: user.id, read_at: null, ...(ids ? { id: { in: ids } } : {}) },
        data: { read_at: new Date() },
    });
    response.json({ count: await unreadCount(user.id) });
});

export default router;
