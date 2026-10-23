import { NotificationType } from '@prisma/client';
import prisma from '../../prismaConnection';
import { logger } from '../../lib/logger';

// u/name or @name, not inside a word or a URL path. Capped so one comment can't ping a crowd.
const MENTION = /(?:^|[^\w/@])(?:@|u\/)([a-z][a-z0-9_]{2,19})\b/gi;
const MAX_MENTIONS = 5;

export function findMentions(body: string): string[] {
    const names = new Set<string>();
    for (const match of body.matchAll(MENTION)) {
        names.add(match[1].toLowerCase());
        if (names.size >= MAX_MENTIONS) break;
    }
    return [...names];
}

type NewComment = {
    id: string;
    post_id: string;
    author_id: string;
    parent_id: string | null;
    body: string;
};

// Tells the post's author (top-level comment) or the parent comment's author (reply), plus anyone mentioned.
// Never notifies the commenter, anyone who blocked them, or a suspended account. Best effort: a failure here
// is logged and never fails the comment itself.
export async function notifyForComment(comment: NewComment) {
    try {
        const recipients = new Map<string, NotificationType>();

        if (comment.parent_id) {
            const parent = await prisma.comment.findUnique({ where: { id: comment.parent_id }, select: { author_id: true } });
            if (parent) recipients.set(parent.author_id, 'comment_reply');
        } else {
            const post = await prisma.post.findUnique({ where: { id: comment.post_id }, select: { author_id: true } });
            if (post) recipients.set(post.author_id, 'post_reply');
        }

        const mentioned = findMentions(comment.body);
        if (mentioned.length > 0) {
            const users = await prisma.user.findMany({ where: { username: { in: mentioned }, status: 'active' }, select: { id: true } });
            // A reply already notifies its recipient; don't send them a second, weaker "mention"
            for (const user of users) if (!recipients.has(user.id)) recipients.set(user.id, 'mention');
        }

        recipients.delete(comment.author_id);
        if (recipients.size === 0) return;

        const ids = [...recipients.keys()];
        const [blocks, active] = await Promise.all([
            prisma.block.findMany({ where: { blocker_id: { in: ids }, blocked_id: comment.author_id }, select: { blocker_id: true } }),
            prisma.user.findMany({ where: { id: { in: ids }, status: 'active' }, select: { id: true } }),
        ]);
        const blockedBy = new Set(blocks.map((block) => block.blocker_id));
        const activeIds = new Set(active.map((user) => user.id));

        await prisma.notification.createMany({
            data: ids
                .filter((id) => activeIds.has(id) && !blockedBy.has(id))
                .map((id) => ({
                    user_id: id,
                    actor_id: comment.author_id,
                    type: recipients.get(id)!,
                    post_id: comment.post_id,
                    comment_id: comment.id,
                })),
            skipDuplicates: true,
        });
    } catch (error) {
        logger.error({ err: error, commentId: comment.id }, 'Notification fan-out failed');
    }
}
