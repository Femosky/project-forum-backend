import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import request from 'supertest';
import app from '../src/app';
import { env } from '../src/config/env';
import { createCommunity, signInStaff, signUp } from './helpers';

describe('posting as a seed account', () => {
    it('lets owners and admins open a thread as a seed account, and nobody else', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        await prisma.user.create({ data: { username: 'seed_ada', email: 'seed_ada@seed.invalid', display_name: 'Ada', is_seed: true } });
        const admin = await signInStaff('boss', 'admin');
        const mod = await signInStaff('helper', 'moderator');

        const list = await admin.agent.get('/v1/admin/seed-accounts');
        expect(list.status).toBe(200);
        expect(list.body.accounts).toEqual([{ username: 'seed_ada', display_name: 'Ada' }]);

        const post = { as: 'seed_ada', community: 'lounge', title: 'Where to find the best suya in Abuja', body: 'Visiting next week.' };
        expect((await mod.agent.post('/v1/admin/seed-posts').send(post)).status).toBe(403);
        expect((await alice.agent.post('/v1/admin/seed-posts').send(post)).status).toBe(401);
        // Real accounts can't be posted as
        expect((await admin.agent.post('/v1/admin/seed-posts').send({ ...post, as: 'alice' })).body.error.code).toBe('not_seed_account');

        const created = await admin.agent.post('/v1/admin/seed-posts').send(post);
        expect(created.status).toBe(201);
        expect(created.body.post.path).toMatch(/^\/c\/lounge\/[a-z0-9]{8}\/where-to-find-the-best-suya-in-abuja$/);
        const stored = await prisma.post.findUniqueOrThrow({ where: { id: created.body.post.id }, include: { author: true } });
        expect(stored).toMatchObject({ title: post.title, body: post.body, status: 'active', author: { username: 'seed_ada' } });
        expect((await prisma.community.findUniqueOrThrow({ where: { name: 'lounge' } })).post_count).toBe(1);
        expect(await prisma.staffAudit.count({ where: { action: 'seed_post' } })).toBe(1);
    });

    it('lets the daily routine post with SEED_POST_KEY, off while unset and capped per day', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        await prisma.user.create({ data: { username: 'seed_ada', email: 'seed_ada@seed.invalid', is_seed: true } });
        const post = { as: 'seed_ada', community: 'lounge', title: 'What is the best way to save in naira?', body: 'Asking for a friend.' };
        const key = 'k'.repeat(40);

        const saved = env.SEED_POST_KEY;
        try {
            env.SEED_POST_KEY = undefined;
            expect((await request(app).post('/v1/seed-posts').set('Authorization', `Bearer ${key}`).send(post)).status).toBe(404);

            env.SEED_POST_KEY = key;
            expect((await request(app).post('/v1/seed-posts').send(post)).status).toBe(401);
            expect((await request(app).post('/v1/seed-posts').set('Authorization', 'Bearer wrong').send(post)).status).toBe(401);
            const accounts = await request(app).get('/v1/seed-posts/accounts').set('Authorization', `Bearer ${key}`);
            expect(accounts.body.accounts.map((a: { username: string }) => a.username)).toEqual(['seed_ada']);

            const created = await request(app).post('/v1/seed-posts').set('Authorization', `Bearer ${key}`).send(post);
            expect(created.status).toBe(201);
            expect(await prisma.staffAudit.count({ where: { action: 'seed_post', staff_id: null } })).toBe(1);

            // Ten a day at most
            await prisma.staffAudit.createMany({ data: Array.from({ length: 9 }, () => ({ action: 'seed_post' })) });
            const capped = await request(app).post('/v1/seed-posts').set('Authorization', `Bearer ${key}`).send({ ...post, title: 'Another one today' });
            expect(capped.status).toBe(429);
        } finally {
            env.SEED_POST_KEY = saved;
        }
    });

    it('lets the key reply as the site account and run the live switch, only on seed threads', async () => {
        const alice = await signUp('alice');
        await createCommunity(alice.agent, 'lounge');
        const site = await prisma.user.upsert({
            where: { username: 'site_team' },
            update: { is_seed: true },
            create: { username: 'site_team', email: 'site-team@invalid.local', is_seed: true },
        });
        const key = 'k'.repeat(40);
        const auth = { Authorization: `Bearer ${key}` };

        const saved = env.SEED_POST_KEY;
        try {
            env.SEED_POST_KEY = key;
            const thread = await request(app).post('/v1/seed-posts').set(auth).send({ as: 'site_team', community: 'lounge', title: 'Live: Final', body: '' });
            const shortId = thread.body.post.short_id;
            const human = await alice.agent.post('/v1/posts').send({ community: 'lounge', type: 'text', title: 'My own thread', body: 'hi' });
            expect(human.status).toBe(201);

            // Same key gate as posting
            expect((await request(app).post(`/v1/seed-posts/${shortId}/comments`).send({ body: 'x' })).status).toBe(401);
            // Never on real people's threads
            const onHuman = await request(app).post(`/v1/seed-posts/${human.body.post.short_id}/comments`).set(auth).send({ body: 'Hello' });
            expect(onHuman.body.error.code).toBe('not_seed_thread');
            expect((await request(app).put(`/v1/seed-posts/${human.body.post.short_id}/live`).set(auth).send({ live: true })).status).toBe(403);
            expect((await request(app).post('/v1/seed-posts/zzzzzzzz/comments').set(auth).send({ body: 'Hello' })).status).toBe(404);
            // Top-level, text only: an "as" or parent_id is ignored, not honoured
            const wentLive = await request(app).put(`/v1/seed-posts/${shortId}/live`).set(auth).send({ live: true });
            expect(wentLive.status).toBe(200);
            expect(wentLive.body.post.live.is_live).toBe(true);

            const reply = await request(app).post(`/v1/seed-posts/${shortId}/comments`).set(auth).send({ body: "GOAL! 1-0 on 23'", as: 'alice', parent_id: thread.body.post.id });
            expect(reply.status).toBe(201);
            const stored = await prisma.comment.findUniqueOrThrow({ where: { id: reply.body.comment.id } });
            expect(stored).toMatchObject({ author_id: site.id, depth: 0, parent_id: null, status: 'active', body: "GOAL! 1-0 on 23'" });
            expect((await prisma.post.findUniqueOrThrow({ where: { id: thread.body.post.id } })).comment_count).toBe(1);
            expect(await prisma.staffAudit.count({ where: { action: 'seed_comment', staff_id: null } })).toBe(1);
            expect(await prisma.staffAudit.count({ where: { action: 'seed_live', staff_id: null } })).toBe(1);

            // It shows in the live-updates poll the page uses
            const updates = await request(app).get(`/v1/posts/${shortId}/live-updates`);
            expect(updates.body.comments.map((c: { id: string }) => c.id)).toContain(stored.id);

            // Thirty a day at most
            await prisma.staffAudit.createMany({ data: Array.from({ length: 29 }, () => ({ action: 'seed_comment' })) });
            expect((await request(app).post(`/v1/seed-posts/${shortId}/comments`).set(auth).send({ body: 'One more' })).status).toBe(429);

            const ended = await request(app).put(`/v1/seed-posts/${shortId}/live`).set(auth).send({ live: false });
            expect(ended.body.post.live.is_live).toBe(false);
        } finally {
            env.SEED_POST_KEY = saved;
        }
    });
});
