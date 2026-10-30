import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { createCommunity, signInStaff, signUp } from './helpers';

// Trusted accounts: marked by the site's owners and admins, they skip the new-account limits

describe('trusted accounts', () => {
    it('lets a trusted new account post links straight away; only owners and admins can mark it, and it is logged', async () => {
        const owner = await signUp('owner');
        await createCommunity(owner.agent, 'lounge');
        const fresh = await signUp('newcomer', { fresh: true });
        const link = { community: 'lounge', type: 'link', title: 'A useful guide to renting in Lagos', url: 'https://example.com/guide' };

        expect((await fresh.agent.post('/v1/posts').send(link)).status).toBe(403);

        const moderator = await signInStaff('mod', 'moderator');
        expect((await moderator.agent.post('/v1/admin/users/newcomer/trusted').send({ trusted: true })).status).toBe(403);

        const admin = await signInStaff('boss', 'admin');
        const marked = await admin.agent.post('/v1/admin/users/newcomer/trusted').send({ trusted: true });
        expect(marked.status).toBe(200);
        expect(marked.body.user).toMatchObject({ username: 'newcomer', is_trusted: true });
        expect(await prisma.staffAudit.findFirst({ where: { action: 'trust_user', target_id: fresh.user.id } })).not.toBeNull();

        expect((await fresh.agent.post('/v1/posts').send(link)).status).toBe(201);
        const me = await fresh.agent.get('/v1/auth/me');
        expect(me.body.user).toMatchObject({ can_post_links: true });

        // Taking it back puts the limits back
        await admin.agent.post('/v1/admin/users/newcomer/trusted').send({ trusted: false });
        expect((await fresh.agent.post('/v1/posts').send({ ...link, title: 'Another guide to renting in Lagos', url: 'https://example.com/guide-2' })).status).toBe(403);
    });
});
