import prisma from '../../prismaConnection';
import { env } from '../../config/env';
import { defineJob } from '../../lib/jobs';
import { fetchLinkPreview } from '../../lib/linkPreview';
import logger from '../../lib/logger';
import { checkContent } from '../safety/moderation';

// Fills in a link post's preview card after it is created, so posting never waits on someone else's server. The
// card's picture and text go through the same automatic check as posts: a sexual picture holds the post for the
// admins, a graphic one adds the mature label, and mature (NSFW) posts never show a preview picture.
export const linkPreviewJob = defineJob<{ postId: string; url: string }>(
    'post.link-preview',
    async ({ postId, url }) => {
        if (!env.LINK_PREVIEWS_ENABLED) return;
        try {
            const preview = await fetchLinkPreview(url);
            if (!preview) return;
            const post = await prisma.post.findUnique({
                where: { id: postId },
                select: { status: true, is_nsfw: true, shadow_hidden: true, community_id: true, community: { select: { is_nsfw: true } } },
            });
            if (!post) return;

            const verdict = await checkContent({
                text: [preview.title, preview.description].filter(Boolean).join('\n'),
                imageUrls: preview.image ? [preview.image] : [],
            });
            const mature = post.is_nsfw || post.community.is_nsfw || verdict.action !== 'publish';
            const card = mature ? { ...preview, image: undefined } : preview;

            if (verdict.action === 'hold' || verdict.action === 'hold_for_admins') {
                const wasListed = post.status === 'active' || post.status === 'locked';
                await prisma.$transaction([
                    prisma.post.update({
                        where: { id: postId },
                        data: {
                            link_preview: card,
                            ...(wasListed
                                ? {
                                      status: 'pending',
                                      held_reason: `Link preview: ${verdict.reason}`,
                                      held_for_admins: verdict.action === 'hold_for_admins',
                                      pinned_at: null,
                                  }
                                : {}),
                        },
                    }),
                    ...(wasListed && !post.shadow_hidden
                        ? [prisma.community.update({ where: { id: post.community_id }, data: { post_count: { decrement: 1 } } })]
                        : []),
                ]);
                return;
            }
            await prisma.post.update({
                where: { id: postId },
                data: { link_preview: card, ...(verdict.action === 'label_mature' ? { is_nsfw: true } : {}) },
            });
        } catch (error) {
            // Unreachable or unsafe links just get no preview; not worth retrying
            logger.info({ err: error, postId }, 'Link preview skipped');
        }
    },
    { retryLimit: 1 }
);
