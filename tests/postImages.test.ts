import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { LOCAL_MEDIA_DIR } from '../src/lib/storage';
import prisma from '../src/prismaConnection';
import { api, createCommunity, signUp } from './helpers';

// Pictures in posts: uploaded to our storage, redrawn without EXIF or location, checked before they can be posted

const realFetch = globalThis.fetch;

function fakeModeration(scores: Record<string, number>) {
    env.OPENAI_API_KEY = 'test-key';
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith('https://api.openai.com/')) return realFetch(input, init);
        return new Response(JSON.stringify({ results: [{ category_scores: scores }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
}

afterEach(() => {
    vi.restoreAllMocks();
    delete env.OPENAI_API_KEY;
});

// A phone photo with a camera make and GPS coordinates in its EXIF
const phonePhoto = () =>
    sharp({ create: { width: 1200, height: 1600, channels: 3, background: '#cc6633' } })
        .withExif({ IFD0: { Make: 'SecretPhone' }, GPS: { GPSLatitudeRef: 'N', GPSLatitude: '6/1 27/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '3/1 23/1 0/1' } })
        .jpeg()
        .toBuffer();

const upload = async (agent: Awaited<ReturnType<typeof signUp>>['agent'], body: Buffer) =>
    agent.post('/v1/images?purpose=post_image').set('Content-Type', 'image/jpeg').send(body);

describe('picture posts', () => {
    it('uploads a picture without its location data and posts it, keeping its shape', async () => {
        const author = await signUp('author');
        await createCommunity(author.agent, 'lounge');
        const uploaded = await upload(author.agent, await phonePhoto());
        expect(uploaded.status).toBe(201);
        expect(uploaded.body.image).toMatchObject({ width: 1200, height: 1600 });

        const file = path.join(LOCAL_MEDIA_DIR, new URL(uploaded.body.image.url).pathname.replace(/^\/media\//, ''));
        expect(existsSync(file)).toBe(true);
        const meta = await sharp(file).metadata();
        expect(meta.format).toBe('webp');
        expect(meta.exif).toBeUndefined();

        const created = await author.agent
            .post('/v1/posts')
            .send({ community: 'lounge', type: 'image', title: 'View from the bridge this morning', image: uploaded.body.image });
        expect(created.status).toBe(201);
        expect(created.body.post).toMatchObject({ type: 'image', status: 'active', image: { url: uploaded.body.image.url, width: 1200, height: 1600 } });
        expect((await api().get(`/v1/posts/${created.body.post.short_id}`)).body.post.image.url).toBe(uploaded.body.image.url);
    });

    it('only takes pictures uploaded here, and not from brand-new accounts', async () => {
        const author = await signUp('author');
        await createCommunity(author.agent, 'lounge');
        const elsewhere = await author.agent
            .post('/v1/posts')
            .send({ community: 'lounge', type: 'image', title: 'Hotlinked picture', image: { url: 'https://example.com/photo.jpg', width: 10, height: 10 } });
        expect(elsewhere.status).toBe(400);
        const missing = await author.agent.post('/v1/posts').send({ community: 'lounge', type: 'image', title: 'No picture at all' });
        expect(missing.status).toBe(400);

        const fresh = await signUp('freshie', { fresh: true });
        const refused = await upload(fresh.agent, await phonePhoto());
        expect(refused.status).toBe(403);
        expect(refused.body.error.code).toBe('new_account_pictures');
    });

    it('refuses a sexual picture at upload, and labels a graphic picture post mature', async () => {
        const author = await signUp('author');
        await createCommunity(author.agent, 'lounge');
        fakeModeration({ sexual: 0.95 });
        const refused = await upload(author.agent, await phonePhoto());
        expect(refused.status).toBe(400);
        expect(refused.body.error.code).toBe('image_refused');

        vi.restoreAllMocks();
        fakeModeration({ 'violence/graphic': 0.7 });
        const uploaded = await upload(author.agent, await phonePhoto());
        expect(uploaded.status).toBe(201);
        const created = await author.agent
            .post('/v1/posts')
            .send({ community: 'lounge', type: 'image', title: 'Aftermath of the crash on the expressway', image: uploaded.body.image });
        expect(await prisma.post.findUniqueOrThrow({ where: { id: created.body.post.id } })).toMatchObject({ status: 'active', is_nsfw: true });
    });
});

describe('picture sizes', () => {
    it('caps a big phone photo at 2048 px with a 720 px copy for feeds, and keeps a moving GIF moving', async () => {
        const author = await signUp('author');
        const photo = await sharp({ create: { width: 4032, height: 3024, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 12 } } }).jpeg({ quality: 80 }).toBuffer();
        const big = await upload(author.agent, photo);
        expect(big.status).toBe(201);
        expect(big.body.image).toMatchObject({ width: 2048, height: 1536 });
        expect(big.body.image.variants.map((variant: { width: number }) => variant.width)).toEqual([2048, 720]);

        // Two frames, red then blue
        const frame = (colour: string) => sharp({ create: { width: 60, height: 40, channels: 3, background: colour } }).png().toBuffer();
        const gif = await sharp([await frame('#ff0000'), await frame('#0000ff')], { join: { animated: true } }).gif().toBuffer();
        const moving = await author.agent.post('/v1/images?purpose=post_image').set('Content-Type', 'image/gif').send(gif);
        expect(moving.status).toBe(201);
        expect(moving.body.image).toMatchObject({ width: 60, height: 40 });
        const file = path.join(LOCAL_MEDIA_DIR, new URL(moving.body.image.url).pathname.replace(/^\/media\//, ''));
        expect((await sharp(file, { animated: true }).metadata()).pages).toBe(2);
    });
});

describe('the site’s own picture check on posts', () => {
    it('refuses clear cases at upload, holds borderline ones for the admins, labels revealing ones mature', async () => {
        const imageCheck = await import('../src/modules/safety/imageCheck');
        const author = await signUp('author');
        await createCommunity(author.agent, 'lounge');
        const spy = vi.spyOn(imageCheck, 'checkImage');

        spy.mockResolvedValue({ action: 'refuse', reason: "This picture can't be posted. Sexual content isn't allowed on the site." });
        const refused = await upload(author.agent, await phonePhoto());
        expect(refused.status).toBe(400);

        spy.mockResolvedValue({ action: 'hold_for_admins', reason: 'Picture may be sexual (automatic check)' });
        const borderline = await upload(author.agent, await phonePhoto());
        expect(borderline.status).toBe(201);
        const held = await author.agent.post('/v1/posts').send({ community: 'lounge', type: 'image', title: 'Beach day in Lagos', image: borderline.body.image });
        expect(await prisma.post.findUniqueOrThrow({ where: { id: held.body.post.id } })).toMatchObject({ status: 'pending', held_for_admins: true });

        spy.mockResolvedValue({ action: 'label_mature', reason: 'Revealing picture' });
        const revealing = await upload(author.agent, await phonePhoto());
        const labelled = await author.agent.post('/v1/posts').send({ community: 'lounge', type: 'image', title: 'Swimwear haul from the market', image: revealing.body.image });
        expect(await prisma.post.findUniqueOrThrow({ where: { id: labelled.body.post.id } })).toMatchObject({ status: 'active', is_nsfw: true });
    });
});
