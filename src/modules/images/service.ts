import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { badRequest } from '../../lib/http';
import logger from '../../lib/logger';
import { putObject } from '../../lib/storage';

// Image uploads: ad logos and pictures, community icons and banners. (No profile photos, by decision: people keep
// drawn avatars, which protects anonymity and saves storage. Images in posts and comments come later, with automatic
// moderation on every upload.)
//
// Every upload is decoded and redrawn: EXIF and other metadata are dropped (location, camera), the picture is turned
// upright, cut to the shape its slot needs and saved as WebP in a couple of sizes. The original is never stored.

export const IMAGE_PURPOSES = ['ad_logo', 'ad_image', 'community_icon', 'community_banner'] as const;
export type ImagePurpose = (typeof IMAGE_PURPOSES)[number];

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ACCEPTED = new Set(['jpeg', 'png', 'webp', 'gif']);
// Bigger than this in either direction is refused before decoding the whole thing
const MAX_SOURCE_SIDE = 8000;

// Output sizes per slot, largest first. Ratios match where they're shown, so the page reserves the right space.
const VARIANTS: Record<ImagePurpose, { width: number; height: number }[]> = {
    ad_logo: [{ width: 256, height: 256 }],
    // The feed card's 1.91:1 picture
    ad_image: [
        { width: 1200, height: 628 },
        { width: 600, height: 314 },
    ],
    community_icon: [{ width: 256, height: 256 }],
    // 4:1 header banner
    community_banner: [
        { width: 1600, height: 400 },
        { width: 800, height: 200 },
    ],
};

export type StoredImage = { url: string; width: number; height: number; variants: { url: string; width: number; height: number }[] };

// The place to check what's in a picture before it goes public (nudity, gore, scams). Today's uploads come only from
// admins and community moderators, so nothing is scanned yet; the scanning service plugs in here, and a refusal
// stops the upload before anything is stored.
export async function scanImage(input: { image: Buffer; purpose: ImagePurpose; uploaderId: string }): Promise<{ allowed: boolean; reason?: string }> {
    void input;
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
            const output = await sharp(body, { animated: false })
                .rotate()
                .resize(width, height, { fit: 'cover', position: 'attention', withoutEnlargement: false })
                .webp({ quality: 82 })
                .toBuffer();
            const url = await putObject(`img/${purpose}/${id}-${width}.webp`, output, 'image/webp');
            return { url, width, height };
        })
    );
    logger.info({ purpose, uploaderId, bytes: body.length }, 'Image stored');
    return { ...variants[0], variants };
}
