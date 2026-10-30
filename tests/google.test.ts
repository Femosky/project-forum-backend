import { describe, expect, it, vi } from 'vitest';
import prisma from '../src/prismaConnection';
import { api, signUp } from './helpers';

// Google's token check is replaced by one that reads "google-id|email" from the token
vi.mock('../src/modules/auth/google', () => ({
    verifyGoogleIdToken: async (token: string) => {
        const [googleId, email] = token.split('|');
        return { googleId, email };
    },
}));

describe('continue with Google', () => {
    it('asks a new person for a username, then creates a verified account with an avatar', async () => {
        const token = 'g-new-1|ngozi.eze@example.test';
        const first = await api().post('/v1/auth/google').send({ id_token: token });
        expect(first.status).toBe(400);
        expect(first.body.error.code).toBe('google_signup_details');
        expect(first.body.error.details).toMatchObject({ email: 'ngozi.eze@example.test', suggested_username: 'ngozi_eze' });

        const joined = await api().post('/v1/auth/google').send({ id_token: token, username: 'ngozi', is_adult: true });
        expect(joined.status).toBe(201);
        const user = await prisma.user.findUniqueOrThrow({ where: { username: 'ngozi' } });
        expect(user.google_id).toBe('g-new-1');
        expect(user.email_verified_at).not.toBeNull();
        expect(user.avatar_config).not.toBeNull();

        // Next time the same Google account just signs in
        expect((await api().post('/v1/auth/google').send({ id_token: token })).status).toBe(200);
    });

    it("won't link to an existing email until the owner signs in with their password", async () => {
        const { agent } = await signUp('alice');
        const token = 'g-alice|alice@example.test';
        const refused = await api().post('/v1/auth/google').send({ id_token: token, username: 'alice2', is_adult: true });
        expect(refused.status).toBe(409);
        expect(refused.body.error.code).toBe('google_link_required');
        expect((await prisma.user.findUniqueOrThrow({ where: { username: 'alice' } })).google_id).toBeNull();

        expect((await agent.post('/v1/auth/google/link').send({ id_token: token })).status).toBe(200);
        expect((await api().post('/v1/auth/google').send({ id_token: token })).status).toBe(200);

        // A Google account connected to someone else can't be connected again
        const { agent: bob } = await signUp('bob');
        expect((await bob.post('/v1/auth/google/link').send({ id_token: token })).body.error.code).toBe('google_in_use');
    });
});
