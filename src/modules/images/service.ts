import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { badRequest } from '../../lib/http';
import logger from '../../lib/logger';
import { putObject } from '../../lib/storage';
import { checkContent } from '../safety/moderation';

// Image uploads: ad logos and pictures, community icons and banners, and pictures in posts. (No profile photos, by
// decision: people keep drawn avatars, which protects anonymity and saves storage.)
//
// Every upload is decoded and redrawn: EXIF and other metadata are dropped (location, camera), the picture is turned
// upright, cut to the shape its slot needs and saved as WebP in a couple of sizes. The original is never stored.

export const IMAGE_PURPOSES = ['ad_logo', 'ad_image', 'community_icon', 'community_banner', 'post_image'] as const;
export type ImagePurpose = (typeof IMAGE_PURPOSES)[number];

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ACCEPTED = new Set(['jpeg', 'png', 'webp', 'gif']);
// Bigger than this in either direction is refused before decoding the whole thing
const MAX_SOURCE_SIDE = 8000;

// Output sizes per slot, largest first. Ratios match where they're shown, so the page reserves the right space. A
// size without a height keeps the picture's own shape (fitted inside a square of that width).
const VARIANTS: Record<ImagePurpose, { width: number; height?: number }[]> = {
    ad_logo: [{ width: 256, height: 256 }],
    // Ad pictures keep their shape: the card shows them in a 1.91:1 frame, cropped around the focal point the admin
    // picks or shown whole (AdCreative.image_focus_x/y, image_fit), so nothing is cut off here
    ad_image: [{ width: 1200 }, { width: 600 }],
    community_icon: [{ width: 256, height: 256 }],
    // Pictures in posts keep their shape too; the page reserves space from the stored width and height
    post_image: [{ width: 1600 }, { width: 800 }],
    // 4:1 header banner
    community_banner: [
        { width: 1600, height: 400 },
        { width: 800, height: 200 },
    ],
};

export type StoredImage = { url: string; width: number; height: number; variants: { url: string; width: number; height: number }[] };

// Every upload is checked before anything is stored (modules/safety/moderation.ts): a sexual picture, or one that
// suggests a minor, is refused outright for every purpose, since porn isn't allowed anywhere. Severe violence is
// refused for icons, banners and ads; in a post it may still go up, and the post itself is checked again (held, or
// labelled mature). Fails open like the text check: with no OPENAI_API_KEY or the service down, uploads go through.
export async function scanImage(input: { image: Buffer; purpose: ImagePurpose; uploaderId: string }): Promise<{ allowed: boolean; reason?: string }> {
    // A small copy is enough to judge, and keeps the request light
    const sample = await sharp(input.image, { animated: false }).rotate().resize(512, 512, { fit: 'inside' }).jpeg({ quality: 70 }).toBuffer();
    const verdict = await checkContent({ imageUrls: [`data:image/jpeg;base64,${sample.toString('base64')}`] });
    if (verdict.action === 'hold_for_admins') {
        logger.warn({ purpose: input.purpose, uploaderId: input.uploaderId, reason: verdict.reason }, 'Picture refused by the automatic check');
        return { allowed: false, reason: "This picture can't be posted here. Sexual content isn't allowed on the site." };
    }
    if (verdict.action === 'hold' && input.purpose !== 'post_image') {
        return { allowed: false, reason: "This picture can't be used here." };
    }
    return { allowed: true };
}

export async function processUpload(body: Buffer, purpose: ImagePurpose, uploaderId: string): Promise<StoredImage> {
    if (body.length === 0) throw badRequest('Choose a picture to upload.', 'image_missing');
    if (body.length > MAX_IMAGE_BYTES) throw badRequest('Pictures can be up to 5 MB.', 'image_too_large');

    let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
    try {
        meta = await sharp(body, { animated: false }).metadata();
    } catch {
        throw badRequest('That file is not a picture we can read. Use JPEG, PNG, WebP or GIF.', 'image_unreadable');
    }
    if (!meta.format || !ACCEPTED.has(meta.format)) throw badRequest('Use a JPEG, PNG, WebP or GIF picture.', 'image_type');
    if (!meta.width || !meta.height || meta.width > MAX_SOURCE_SIDE || meta.height > MAX_SOURCE_SIDE) {
        throw badRequest('That picture is too big. Keep it under 8000 pixels on each side.', 'image_dimensions');
    }

    const verdict = await scanImage({ image: body, purpose, uploaderId });
    if (!verdict.allowed) throw badRequest(verdict.reason ?? "This picture can't be used here.", 'image_refused');

    const id = randomUUID();
    const variants = await Promise.all(
        VARIANTS[purpose].map(async ({ width, height }) => {
            // rotate() applies the EXIF orientation; WebP output carries no metadata
            const { data, info } = await sharp(body, { animated: false })
                .rotate()
                .resize(
                    width,
                    height ?? width,
                    height ? { fit: 'cover', position: 'attention', withoutEnlargement: false } : { fit: 'inside', withoutEnlargement: true }
                )
                .webp({ quality: 82 })
                .toBuffer({ resolveWithObject: true });
            const url = await putObject(`img/${purpose}/${id}-${width}.webp`, data, 'image/webp');
            return { url, width: info.width, height: info.height };
        })
    );
    logger.info({ purpose, uploaderId, bytes: body.length }, 'Image stored');
    return { ...variants[0], variants };
}
