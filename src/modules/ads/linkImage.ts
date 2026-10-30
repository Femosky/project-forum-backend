import type { AdCreative } from '@prisma/client';
import { env } from '../../config/env';
import prisma from '../../prismaConnection';
import { fetchLinkPreview, fetchPublicImage } from '../../lib/linkPreview';
import logger from '../../lib/logger';
import { MAX_IMAGE_BYTES, processUpload } from '../images/service';
import { onSitePath, resolveDestination } from './urls';

// An ad without its own picture can show its destination's preview image (og:image), the picture a link shows when
// it's shared. It's fetched once, when the ad is saved (or the admin asks again), redrawn like an upload and kept in
// our storage, never loaded from the advertiser's site: readers' visits don't reach them, it loads as fast as any
// other picture here, and it can't change under us.

// The picture a card shows: its own, else the preview image when that's switched on
export const adPicture = (creative: Pick<AdCreative, 'image_url' | 'use_link_image' | 'link_image_url'>) =>
    creative.image_url ?? (creative.use_link_image ? creative.link_image_url : null);

async function findLinkImage(clickUrl: string, uploaderId: string): Promise<string | null> {
    // Pages on this site have their own share images, but those are drawn per page; a house ad gets a picture upload
    if (onSitePath(clickUrl) !== null || !env.LINK_PREVIEWS_ENABLED) return null;
    const preview = await fetchLinkPreview(resolveDestination(clickUrl));
    if (!preview?.image) return null;
    const picture = await fetchPublicImage(preview.image, MAX_IMAGE_BYTES);
    if (!picture) return null;
    return (await processUpload(picture, 'ad_image', uploaderId)).url;
}

// Fetches (again) the preview image for one ad and stores the result; a failure just leaves it without one
export async function refreshLinkImage(creativeId: string, uploaderId: string): Promise<AdCreative> {
    const creative = await prisma.adCreative.findUniqueOrThrow({ where: { id: creativeId } });
    let url: string | null = null;
    try {
        url = await findLinkImage(creative.click_url, uploaderId);
    } catch (error) {
        logger.info({ err: error, creativeId }, 'No preview image for this ad');
    }
    return prisma.adCreative.update({ where: { id: creativeId }, data: { link_image_url: url, link_image_checked_at: new Date() } });
}

// After a save: look for a preview image when the ad would use one and doesn't have one for its current link yet
export function needsLinkImage(creative: AdCreative, clickUrlChanged: boolean) {
    return !creative.image_url && creative.use_link_image && (clickUrlChanged || creative.link_image_checked_at === null);
}
