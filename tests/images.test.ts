import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { anonymousAvatarCode, avatarCode } from '../src/lib/avatars';
import { LOCAL_MEDIA_DIR } from '../src/lib/storage';
import { api, createCommunity, createPost, signUp, signInStaff } from './helpers';

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

async function anonymousPostSetup() {
    const alice = await signUp('alice');
    const bob = await signUp('bob');
    await createCommunity(alice.agent, 'quietplace');
    await createPost(alice.agent, 'quietplace', { title: 'Mine, quietly', is_anonymous: true });
    return { alice, bob };
}

describe('drawn avatars', () => {
    it('marks moderators on their own posts, but never on anonymous ones', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'modplace');
        const named = await createPost(alice.agent, 'modplace', { title: 'From the owner' });
        const hidden = await createPost(alice.agent, 'modplace', { title: 'Quietly', is_anonymous: true });
        expect((await api().get(`/v1/posts/${named.id}`)).body.post.author.is_moderator).toBe(true);
        expect((await api().get(`/v1/posts/${hidden.id}`)).body.post.author).toBeNull();
        expect((await alice.agent.get(`/v1/posts/${hidden.id}`)).body.post.author.is_moderator).toBe(false);
    });

    it('shows anonymous posts on the author\'s own profile, and to nobody else', async () => {
        const { alice, bob } = await anonymousPostSetup();
        expect((await alice.agent.get('/v1/users/alice/posts')).body.posts[0]).toMatchObject({ is_anonymous: true, title: 'Mine, quietly' });
        expect((await bob.agent.get('/v1/users/alice/posts')).body.posts).toEqual([]);
        expect((await api().get('/v1/users/alice/posts')).body.posts).toEqual([]);
    });

    it('gives anonymous items a starter tied to the post, not the person', () => {
        expect(anonymousAvatarCode('user-1', 'post-1')).toBe(anonymousAvatarCode('user-1', 'post-1'));
        expect(anonymousAvatarCode('user-1', 'post-1')).not.toBe(anonymousAvatarCode('user-1', 'post-2'));
    });

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

describe('moving the bucket to a new public address', () => {
    it('rewrites stored image addresses with the old base, and nothing else', async () => {
        const { rebaseMediaUrls } = await import('../src/modules/images/rebase');
        const prisma = (await import('../src/prismaConnection')).default;
        const owner = await signUp('owner');
        await createCommunity(owner.agent, 'Lounge');
        await createCommunity(owner.agent, 'Garden');
        const old = 'https://pub-abc.r2.dev';
        await prisma.community.update({
            where: { name: 'lounge' },
            data: {
                image_url: `${old}/img/community_icon/1-256.webp`,
                banner_url: `${old}/img/community_banner/1-1600.webp`,
            },
        });
        // A look-alike host must not match
        await prisma.community.update({
            where: { name: 'garden' },
            data: { image_url: 'https://pub-abc.r2.dev.evil.test/x.webp' },
        });
        // Picture posts keep their addresses inside JSON
        const post = await createPost(owner.agent, 'lounge', {
            title: 'A picture',
        });
        const picture = (prefix: string) => ({
            url: `${prefix}/img/post_image/2-2048.webp`,
            width: 2048,
            height: 1365,
            variants: [{ url: `${prefix}/img/post_image/2-720.webp`, width: 720, height: 480 }],
        });
        await prisma.post.update({
            where: { short_id: post.short_id },
            data: { image: picture(old) },
        });

        const dryRun = await rebaseMediaUrls(`${old}/`, 'https://media.yarnter.example', false);
        expect(dryRun).toMatchObject({
            'Community.image_url': 1,
            'Community.banner_url': 1,
            'Advertiser.logo_url': 0,
            'Post.image': 1,
        });
        expect((await prisma.community.findUnique({ where: { name: 'lounge' } }))?.image_url).toBe(`${old}/img/community_icon/1-256.webp`);

        await rebaseMediaUrls(old, 'https://media.yarnter.example', true);
        expect(await prisma.community.findUnique({ where: { name: 'lounge' } })).toMatchObject({
            image_url: 'https://media.yarnter.example/img/community_icon/1-256.webp',
            banner_url: 'https://media.yarnter.example/img/community_banner/1-1600.webp',
        });
        expect((await prisma.post.findUnique({ where: { short_id: post.short_id } }))?.image).toEqual(
            picture('https://media.yarnter.example'),
        );
        expect((await prisma.community.findUnique({ where: { name: 'garden' } }))?.image_url).toBe(
            'https://pub-abc.r2.dev.evil.test/x.webp',
        );
        // Running again finds nothing left
        expect(Object.values(await rebaseMediaUrls(old, 'https://media.yarnter.example', true)).every((n) => n === 0)).toBe(true);
        await expect(rebaseMediaUrls(old, `${old}/`, false)).rejects.toThrow('same');
    });
});

describe('earlier bucket addresses', () => {
    it('still count as our uploads until the addresses are rewritten', async () => {
        vi.resetModules();
        vi.stubEnv('R2_ACCOUNT_ID', 'account');
        vi.stubEnv('R2_ACCESS_KEY_ID', 'key');
        vi.stubEnv('R2_SECRET_ACCESS_KEY', 'secret');
        vi.stubEnv('R2_BUCKET', 'bucket');
        vi.stubEnv('R2_PUBLIC_URL', 'https://media.yarnter.example/');
        vi.stubEnv('R2_OLD_PUBLIC_URLS', 'https://pub-abc.r2.dev/, https://media.yarnter.example, not an address');
        try {
            const storage = await import('../src/lib/storage');
            expect(storage.oldMediaBases()).toEqual(['https://pub-abc.r2.dev']);
            expect(storage.isStoredMedia('https://media.yarnter.example/img/community_icon/1-256.webp')).toBe(true);
            expect(storage.isStoredMedia('https://pub-abc.r2.dev/img/community_icon/1-256.webp')).toBe(true);
            expect(storage.isStoredMedia('https://pub-abc.r2.dev.evil.test/img/community_icon/1-256.webp')).toBe(false);
        } finally {
            vi.unstubAllEnvs();
            vi.resetModules();
        }
    });
});
