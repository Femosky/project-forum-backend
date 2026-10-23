import { describe, expect, it } from 'vitest';
import prisma from '../src/prismaConnection';
import { api, signUp } from './helpers';

// Regression tests for roadmap bugs 11, 12, 13 and 14

describe('login errors (bug 12)', () => {
    it('gives the same 401 for an unknown user and a wrong password', async () => {
        await signUp('alice');

        const unknown = await api().post('/auth/login').send({ username: 'ghost', password: 'whatever' });
        const wrong = await api().post('/auth/login').send({ username: 'alice', password: 'wrong-password' });

        expect(unknown.status).toBe(401);
        expect(wrong.status).toBe(401);
        expect(unknown.body).toEqual(wrong.body);
    });
});

describe('auth cookies (bug 13)', () => {
    it('sets HttpOnly, SameSite=Lax cookies with an expiry', async () => {
        const { password } = await signUp('alice');
        const response = await api().post('/auth/login').send({ username: 'alice', password });
        const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);

        const refresh = cookies.find((cookie) => cookie.startsWith('refresh_token='));
        expect(refresh).toBeDefined();
        expect(refresh).toMatch(/HttpOnly/);
        expect(refresh).toMatch(/SameSite=Lax/);
        expect(refresh).toMatch(/Max-Age=\d+/);
        expect(refresh).toMatch(/Path=\//);
    });
});

describe('login sessions (bug 14)', () => {
    it("records the caller's user agent", async () => {
        const { password } = await signUp('alice');
        await api()
            .post('/auth/login')
            .set('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36')
            .send({ username: 'alice', password });

        const session = await prisma.loginSession.findFirstOrThrow({ orderBy: { created_at: 'desc' } });
        expect(session.browser).toBe('Chrome');
        expect(session.user_agent).toContain('Mozilla');
    });
});

describe('error responses (bug 11)', () => {
    it('returns JSON errors without internal details', async () => {
        const notFound = await api().get('/no-such-route');
        expect(notFound.status).toBe(404);
        expect(notFound.body).toEqual({ error: 'Not found' });

        const badJson = await api().post('/auth/login').set('Content-Type', 'application/json').send('{bad');
        expect(badJson.status).toBe(400);
        expect(badJson.body).toEqual({ error: 'Invalid JSON body' });
    });

    it('logs out cleanly without a session', async () => {
        const response = await api().get('/auth/logout');
        expect(response.status).toBe(200);
    });
});
