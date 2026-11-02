import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { avatarCode } from '../src/lib/avatars';
import { LOCAL_MEDIA_DIR } from '../src/lib/storage';
import { createCommunity, signUp, signInStaff } from './helpers';

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
        const admin = await signInStaff('boss');
        const alice = await signUp('alice');
        const body = await photo();
        expect((await alice.agent.post('/v1/admin/images?purpose=ad_logo').set('Content-Type', 'image/jpeg').send(body)).status).toBe(401);
        const logo = await admin.agent.post('/v1/admin/images?purpose=ad_image').set('Content-Type', 'image/jpeg').send(body);
        expect(logo.status).toBe(201);
        // Ad pictures keep their own shape (the card crops around a focal point instead)
        expect(logo.body.image).toMatchObject({ width: 900, height: 600 });
    });
});

describe('drawn avatars', () => {
    it('starts every account on a starter avatar and saves chosen parts by name', async () => {
        const alice = await signUp('alice');
        const me = await alice.agent.get('/v1/auth/me');
        expect(me.body.user.avatar).toBe(avatarCode(null, 'alice'));
        expect(me.body.user.avatar).toMatch(/^s-[0-9a-z]+$/);

        const config = { hair: 'nok-topknot', skin: 'sienna', thread_style: 'fire' };
        const saved = await alice.agent.patch('/v1/users/me').send({ avatar_config: config });
        expect(saved.body.user.avatar).toBe('y1_skin-sienna_hair-nok-topknot_thread_style-fire');
        expect((await alice.agent.get('/v1/users/alice')).body.user.avatar).toBe(saved.body.user.avatar);

        // A part that doesn't exist or an unsafe name is refused; an option the web app adds later needs no API change
        expect((await alice.agent.patch('/v1/users/me').send({ avatar_config: { wings: 'big' } })).status).toBe(400);
        expect((await alice.agent.patch('/v1/users/me').send({ avatar_config: { hair: '../x' } })).status).toBe(400);
        expect((await alice.agent.patch('/v1/users/me').send({ avatar_config: { hair: 'added-in-2030' } })).status).toBe(200);

        // Picking one of the starters is a saved choice too
        expect((await alice.agent.patch('/v1/users/me').send({ avatar_config: { starter: 'teal' } })).body.user.avatar).toBe('y1_starter-teal');

        expect((await alice.agent.patch('/v1/users/me').send({ avatar_config: null })).body.user.avatar).toBe(avatarCode(null, 'alice'));
    });

    it('moves avatars saved in the old numbered format onto a starter', () => {
        expect(avatarCode({ face: 1, skin: 2, hair: 3 }, 'alice')).toBe(avatarCode(null, 'alice'));
    });
});
