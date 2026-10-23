import prisma from '../../prismaConnection';
import { env } from '../../config/env';
import { defineJob } from '../../lib/jobs';
import { fetchLinkPreview } from '../../lib/linkPreview';
import logger from '../../lib/logger';

// Fills in a link post's preview card after it is created, so posting never waits on someone else's server
export const linkPreviewJob = defineJob<{ postId: string; url: string }>(
    'post.link-preview',
    async ({ postId, url }) => {
        if (!env.LINK_PREVIEWS_ENABLED) return;
        try {
            const preview = await fetchLinkPreview(url);
            if (preview) await prisma.post.update({ where: { id: postId }, data: { link_preview: preview } });
        } catch (error) {
            // Unreachable or unsafe links just get no preview; not worth retrying
            logger.info({ err: error, postId }, 'Link preview skipped');
        }
    },
    { retryLimit: 1 }
);
