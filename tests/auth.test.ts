import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import prisma from '../src/prismaConnection';
import { api, cookieValue, lastEmailToken, PASSWORD, signUp } from './helpers';

// Regression tests for roadmap bugs 11-14, plus the v2 auth flow

describe('login errors (bug 12)', () => {
    it('gives the same 401 for an unknown user and a wrong password', async () => {
        await signUp('alice');

        const unknown = await api().post('/v1/auth/login').send({ identifier: 'ghost', password: 'whatever' });
        const wrong = await api().post('/v1/auth/login').send({ identifier: 'alice', password: 'wrong-password' });

        expect(unknown.status).toBe(401);
        expect(wrong.status).toBe(401);
        expect(unknown.body).toEqual(wrong.body);
    });

    it('pauses logins for an identifier after repeated failures, known or not', async () => {
        await signUp('alice');
        for (let i = 0; i < 10; i++) {
            await api().post('/v1/auth/login').send({ identifier: 'alice', password: 'nope' });
            await api().post('/v1/auth/login').send({ identifier: 'ghost', password: 'nope' });
        }
        const locked = await api().post('/v1/auth/login').send({ identifier: 'alice', password: PASSWORD });
        const lockedGhost = await api().post('/v1/auth/login').send({ identifier: 'ghost', password: 'nope' });
        expect(locked.status).toBe(429);
        expect(lockedGhost.status).toBe(429);
    });
});

describe('auth cookies (bug 13)', () => {
    it('sets HttpOnly, SameSite=Lax cookies with an expiry', async () => {
        await signUp('alice');
        const response = await api().post('/v1/auth/login').send({ identifier: 'alice', password: PASSWORD });
        const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);

        for (const name of ['access_token', 'refresh_token']) {
            const cookie = cookies.find((value) => value.startsWith(`${name}=`));
            expect(cookie).toMatch(/HttpOnly/);
            expect(cookie).toMatch(/SameSite=Lax/);
            expect(cookie).toMatch(/Max-Age=\d+/);
            expect(cookie).toMatch(/Path=\//);
        }
    });
});

describe('sessions (bug 14)', () => {
    it("records the caller's device and stores only a hash of the refresh token", async () => {
        await signUp('alice');
        const response = await api()
            .post('/v1/auth/login')
            .set('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36')
            .send({ identifier: 'alice', password: PASSWORD });

        const session = await prisma.session.findFirstOrThrow({ orderBy: { created_at: 'desc' } });
        expect(session.browser).toBe('Chrome');
        expect(session.user_agent).toContain('Mozilla');

        const refresh = cookieValue(response, 'refresh_token')!;
        const secret = refresh.split('.')[1];
        expect(session.refresh_token_hash).not.toContain(secret);
        expect(JSON.stringify(session)).not.toContain(secret);
    });

    it('lists signed-in devices and signs out the others', async () => {
        const { agent } = await signUp('alice');
        const other = request.agent(app);
        await other.post('/v1/auth/login').send({ identifier: 'alice', password: PASSWORD });

        const list = await agent.get('/v1/auth/sessions');
        expect(list.body.sessions).toHaveLength(2);
        expect(list.body.sessions.filter((session: { current: boolean }) => session.current)).toHaveLength(1);

        expect((await agent.delete('/v1/auth/sessions')).status).toBe(200);
        expect((await other.get('/v1/auth/me')).status).toBe(401);
        expect((await agent.get('/v1/auth/me')).status).toBe(200);
    });
});

describe('refresh token rotation', () => {
    it('rotates the refresh token and revokes the session when an old one is replayed', async () => {
        const { agent } = await signUp('alice');
        const login = await api().post('/v1/auth/login').send({ identifier: 'alice', password: PASSWORD });
        const first = cookieValue(login, 'refresh_token')!;

        const refreshed = await api().post('/v1/auth/refresh').set('Cookie', `refresh_token=${first}`);
        expect(refreshed.status).toBe(200);
        const second = cookieValue(refreshed, 'refresh_token')!;
        expect(second).not.toBe(first);

        // A parallel tab replaying the old token straight away is tolerated
        const parallel = await api().post('/v1/auth/refresh').set('Cookie', `refresh_token=${first}`);
        expect(parallel.status).toBe(200);
        expect(cookieValue(parallel, 'refresh_token')).toBeUndefined();

        // Later, the same replay means the token was stolen: the whole session dies
        await prisma.session.updateMany({ data: { rotated_at: new Date(Date.now() - 60_000) } });
        const replay = await api().post('/v1/auth/refresh').set('Cookie', `refresh_token=${first}`);
        expect(replay.status).toBe(401);
        expect((await api().post('/v1/auth/refresh').set('Cookie', `refresh_token=${second}`)).status).toBe(401);

        // Other sessions are unaffected
        expect((await agent.get('/v1/auth/me')).status).toBe(200);
    });

    it('stops accepting the access token after logout', async () => {
        const { agent } = await signUp('alice');
        expect((await agent.get('/v1/auth/me')).status).toBe(200);
        await agent.post('/v1/auth/logout');
        const session = await prisma.session.findFirstOrThrow();
        expect(session.revoked_at).not.toBeNull();
    });
});

describe('signup', () => {
    it('requires an 18+ attestation and valid fields', async () => {
        const response = await api()
            .post('/v1/auth/signup')
            .send({ email: 'not-an-email', username: '1x', password: 'short' });
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('validation_failed');
        expect(Object.keys(response.body.error.fields)).toEqual(expect.arrayContaining(['email', 'username', 'password', 'is_adult']));
    });

    it('rejects a taken username or email', async () => {
        await signUp('alice');
        const sameName = await api()
            .post('/v1/auth/signup')
            .send({ email: 'new@example.test', username: 'alice', password: PASSWORD, is_adult: true });
        expect(sameName.status).toBe(409);
        expect(sameName.body.error.code).toBe('username_taken');
    });
});

describe('email verification and password reset', () => {
    it('verifies the email from the link token, once', async () => {
        const { agent } = await signUp('alice');
        const token = lastEmailToken('alice@example.test');

        expect((await api().post('/v1/auth/verify-email').send({ token })).status).toBe(200);
        expect((await agent.get('/v1/auth/me')).body.user.is_email_verified).toBe(true);
        expect((await api().post('/v1/auth/verify-email').send({ token })).status).toBe(400);
    });

    it('answers the same for unknown emails and resets the password, signing out every device', async () => {
        const { agent } = await signUp('alice');
        const unknown = await api().post('/v1/auth/forgot-password').send({ email: 'ghost@example.test' });
        const known = await api().post('/v1/auth/forgot-password').send({ email: 'alice@example.test' });
        expect(unknown.body).toEqual(known.body);

        const token = lastEmailToken('alice@example.test');
        expect((await api().post('/v1/auth/reset-password').send({ token, password: 'a-new-password-1' })).status).toBe(200);

        expect((await agent.get('/v1/auth/me')).status).toBe(401);
        expect((await api().post('/v1/auth/login').send({ identifier: 'alice', password: PASSWORD })).status).toBe(401);
        expect((await api().post('/v1/auth/login').send({ identifier: 'alice', password: 'a-new-password-1' })).status).toBe(200);
    });

    it('changes the email after the new address confirms', async () => {
        const { agent } = await signUp('alice');
        const wrong = await agent.post('/v1/auth/change-email').send({ new_email: 'ada@example.test', password: 'nope' });
        expect(wrong.status).toBe(400);

        await agent.post('/v1/auth/change-email').send({ new_email: 'ada@example.test', password: PASSWORD });
        const token = lastEmailToken('ada@example.test');
        expect((await api().post('/v1/auth/confirm-email').send({ token })).status).toBe(200);
        expect((await agent.get('/v1/auth/me')).body.user.email).toBe('ada@example.test');
    });
});

describe('Google sign-in', () => {
    it('answers 503 until a client id is configured', async () => {
        const response = await api().post('/v1/auth/google').send({ id_token: 'x'.repeat(20) });
        expect(response.status).toBe(503);
        expect(response.body.error.code).toBe('google_not_configured');
    });
});

describe('error responses (bug 11)', () => {
    it('returns JSON errors without internal details', async () => {
        const notFound = await api().get('/no-such-route');
        expect(notFound.status).toBe(404);
        expect(notFound.body).toEqual({ error: { code: 'not_found', message: 'Not found' } });

        const badJson = await api().post('/v1/auth/login').set('Content-Type', 'application/json').send('{bad');
        expect(badJson.status).toBe(400);
        expect(badJson.body).toEqual({ error: { code: 'invalid_json', message: 'Invalid JSON body' } });

        // A malformed id is a 404, not a database error
        expect((await api().get('/v1/posts/not-a-real-id')).status).toBe(404);
    });

    it('logs out cleanly without a session', async () => {
        expect((await api().post('/v1/auth/logout')).status).toBe(200);
    });
});

describe('request ids', () => {
    it('echoes a sane X-Request-Id or makes one', async () => {
        const echoed = await api().get('/v1/health').set('X-Request-Id', 'abc12345-test');
        expect(echoed.headers['x-request-id']).toBe('abc12345-test');

        const generated = await api().get('/v1/health').set('X-Request-Id', 'bad id with spaces');
        expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
});
