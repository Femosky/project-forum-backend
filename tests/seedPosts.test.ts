import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
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
});
