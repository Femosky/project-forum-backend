import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { AVATAR_PARTS, avatarCode } from '../src/lib/avatars';
import { LOCAL_MEDIA_DIR } from '../src/lib/storage';
import { createCommunity, signUp } from './helpers';

// A JPEG with EXIF data (a camera make), to check uploads drop it
const photo = () =>
    sharp({ create: { width: 900, height: 600, channels: 3, background: '#3355aa' } })
        .withExif({ IFD0: { Make: 'SecretCam' } })
        .jpeg()
        .toBuffer();

describe('image uploads', () => {
    it('lets moderators upload a community icon and banner, redrawn as WebP without metadata', async () => {
        const owner = await signUp('owner');
        const outsider = await signUp('outsider');
        await createCommunity(owner.agent, 'Lounge');
        const body = await photo();

        const upload = (agent: typeof owner.agent, purpose: string, file: Buffer, type = 'image/jpeg') =>
            agent.post(`/v1/images?purpose=${purpose}&community=lounge`).set('Content-Type', type).send(file);

        expect((await upload(outsider.agent, 'community_icon', body)).status).toBe(403);
        const icon = await upload(owner.agent, 'community_icon', body);
        expect(icon.status).toBe(201);
        expect(icon.body.image).toMatchObject({ width: 256, height: 256 });
        const banner = await upload(owner.agent, 'community_banner', body);
        expect(banner.body.image.variants.map((variant: { width: number }) => variant.width)).toEqual([1600, 800]);

        // Stored as WebP, upright, with no EXIF left
        const file = path.join(LOCAL_MEDIA_DIR, new URL(icon.body.image.url).pathname.replace(/^\/media\//, ''));
        expect(existsSync(file)).toBe(true);
        const meta = await sharp(file).metadata();
        expect(meta).toMatchObject({ format: 'webp', width: 256, height: 256 });
        expect(meta.exif).toBeUndefined();

        // Only our own stored files can be set as the icon or banner
        const saved = await owner.agent.patch('/v1/communities/lounge').send({ image_url: icon.body.image.url, banner_url: banner.body.image.url });
        expect(saved.body.community).toMatchObject({ image_url: icon.body.image.url, banner_url: banner.body.image.url });
        expect((await owner.agent.patch('/v1/communities/lounge').send({ image_url: 'https://evil.example/x.png' })).status).toBe(400);

        // Not a picture, or too big
        expect((await upload(owner.agent, 'community_icon', Buffer.from('not an image'))).body.error.code).toBe('image_unreadable');
        expect((await upload(owner.agent, 'community_icon', Buffer.alloc(5 * 1024 * 1024 + 10))).status).toBe(400);
    });

    it('takes ad pictures from admins only', async () => {
        const admin = await signUp('boss', { admin: true });
        const alice = await signUp('alice');
        const body = await photo();
        expect((await alice.agent.post('/v1/admin/images?purpose=ad_logo').set('Content-Type', 'image/jpeg').send(body)).status).toBe(403);
        const logo = await admin.agent.post('/v1/admin/images?purpose=ad_image').set('Content-Type', 'image/jpeg').send(body);
        expect(logo.status).toBe(201);
        expect(logo.body.image).toMatchObject({ width: 1200, height: 628 });
    });
});

describe('drawn avatars', () => {
    it('gives every new account its own avatar and lets them change it within the parts that exist', async () => {
        const alice = await signUp('alice');
        const me = await alice.agent.get('/v1/auth/me');
        expect(me.body.user.avatar).toMatch(new RegExp(`^[0-9a-z]{${Object.keys(AVATAR_PARTS).length}}$`));

        const config = Object.fromEntries(Object.keys(AVATAR_PARTS).map((part) => [part, 1]));
        const saved = await alice.agent.patch('/v1/users/me').send({ avatar_config: config });
        expect(saved.body.user.avatar).toBe(avatarCode(config));
        expect((await alice.agent.patch('/v1/users/me').send({ avatar_config: { ...config, hair: 99 } })).status).toBe(400);
        expect((await alice.agent.get('/v1/users/alice')).body.user.avatar).toBe(avatarCode(config));

        // Back to the one derived from the username
        expect((await alice.agent.patch('/v1/users/me').send({ avatar_config: null })).body.user.avatar).toBeNull();
    });
});
