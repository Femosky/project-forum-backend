import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from '../src/app';
import prisma from '../src/prismaConnection';
import { devOutbox } from '../src/lib/email';
import { hashPassword } from '../src/modules/auth/service';
import { decryptSecret, totpCode, verifyTotp } from '../src/modules/staff/totp';
import { api, PASSWORD, signInStaff, signUp } from './helpers';

const STRONG = 'N3w-staff-passw0rd!';

describe('totp', () => {
    it('matches the RFC 6238 test vector and allows one step of clock drift', () => {
        // RFC 6238 appendix B, SHA-1, secret "12345678901234567890" in base32, T = 59 s -> 94287082 (last 6 digits)
        const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
        expect(totpCode(secret, 59_000)).toBe('287082');
        expect(verifyTotp(secret, '287082', 59_000 + 30_000)).toBe(true);
        expect(verifyTotp(secret, '287082', 59_000 + 90_000)).toBe(false);
        expect(verifyTotp(secret, 'abcdef', 59_000)).toBe(false);
    });
});

describe('staff sign-in', () => {
    it('takes the first owner from a temporary password through 2FA setup to a new password', async () => {
        await prisma.staffAccount.create({
            data: { email: 'femi@staff.test', name: 'Femi', role: 'owner', password_hash: await hashPassword('temp-pass-123'), password_temporary: true },
        });
        const agent = request.agent(app);

        expect((await agent.post('/v1/admin/auth/login').send({ email: 'femi@staff.test', password: 'wrong' })).status).toBe(401);
        const login = await agent.post('/v1/admin/auth/login').send({ email: 'FEMI@staff.test', password: 'temp-pass-123' });
        expect(login.body.step).toBe('setup_2fa');
        // Two cookies with the same session: one for the web app's /admin pages, one for the admin API
        const cookies = ([] as string[]).concat(login.headers['set-cookie']);
        expect(cookies.some((cookie) => /staff_session=.*Path=\/v1\/admin/.test(cookie))).toBe(true);
        expect(cookies.some((cookie) => /staff_session=.*Path=\/admin;/.test(cookie))).toBe(true);
        expect(cookies.every((cookie) => /HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie))).toBe(true);

        // Half signed in: nothing in the panel works yet
        expect((await agent.get('/v1/admin/overview')).status).toBe(401);

        const setup = await agent.get('/v1/admin/auth/2fa/setup');
        expect(setup.body.otpauth_url).toContain('otpauth://totp/');
        expect(setup.body.qr_svg).toContain('<svg');
        expect((await agent.post('/v1/admin/auth/2fa/setup').send({ code: '000000' })).body.error.code).toBe('invalid_code');
        const done = await agent.post('/v1/admin/auth/2fa/setup').send({ code: totpCode(setup.body.secret) });
        expect(done.body.recovery_codes).toHaveLength(10);
        // The secret is stored encrypted
        const stored = await prisma.staffAccount.findUniqueOrThrow({ where: { email: 'femi@staff.test' } });
        expect(stored.totp_secret).not.toContain(setup.body.secret);
        expect(decryptSecret(stored.totp_secret!)).toBe(setup.body.secret);

        // Still on the temporary password: only changing it works
        expect((await agent.get('/v1/admin/overview')).body.error.code).toBe('password_change_required');
        expect((await agent.get('/v1/admin/auth/me')).body.staff.password_change_required).toBe(true);
        await agent.post('/v1/admin/auth/password').send({ current_password: 'temp-pass-123', new_password: STRONG }).expect(200);
        expect((await agent.get('/v1/admin/overview')).status).toBe(200);

        // Next time: password, then a code (or a recovery code, once)
        const next = request.agent(app);
        expect((await next.post('/v1/admin/auth/login').send({ email: 'femi@staff.test', password: STRONG })).body.step).toBe('verify_2fa');
        expect((await next.post('/v1/admin/auth/2fa/verify').send({ recovery_code: done.body.recovery_codes[0] })).body.recovery_codes_left).toBe(9);
        const again = request.agent(app);
        await again.post('/v1/admin/auth/login').send({ email: 'femi@staff.test', password: STRONG });
        expect((await again.post('/v1/admin/auth/2fa/verify').send({ recovery_code: done.body.recovery_codes[0] })).status).toBe(400);

        const audit = await next.get('/v1/admin/audit');
        expect(audit.body.entries.map((entry: { action: string }) => entry.action)).toEqual(
            expect.arrayContaining(['setup_2fa', 'login', 'change_password', 'login_recovery_code', 'login_failed'])
        );
    });

    it('keeps forum and staff sign-ins apart, locks out repeated wrong passwords, and signs out', async () => {
        const forum = await signUp('alice');
        // A forum session opens nothing in the panel, and a staff session gives no forum identity
        expect((await forum.agent.get('/v1/admin/overview')).status).toBe(401);
        const { agent } = await signInStaff('root', 'admin');
        expect((await agent.get('/v1/auth/me')).status).toBe(401);
        expect((await agent.post('/v1/posts').send({ community: 'x', title: 'hello there' })).status).toBe(401);

        for (let attempt = 0; attempt < 5; attempt++) await api().post('/v1/admin/auth/login').send({ email: 'root@staff.test', password: 'nope' });
        expect((await api().post('/v1/admin/auth/login').send({ email: 'root@staff.test', password: PASSWORD })).status).toBe(429);

        await agent.post('/v1/admin/auth/logout').expect(200);
        expect((await agent.get('/v1/admin/overview')).status).toBe(401);
    });
});

describe('managing staff', () => {
    it('lets the owner invite, change roles, reset 2FA and deactivate, and nobody else', async () => {
        const owner = await signInStaff('boss', 'owner');
        const admin = await signInStaff('helper', 'admin');
        expect((await admin.agent.get('/v1/admin/staff')).status).toBe(403);

        const invited = await owner.agent.post('/v1/admin/staff').send({ email: 'new@staff.test', name: 'New person', role: 'ads' });
        expect(invited.status).toBe(201);
        expect(invited.body.staff).toMatchObject({ role: 'ads', has_password: false, has_2fa: false });
        const token = new URL(invited.body.invite_url).searchParams.get('token')!;
        expect(devOutbox.some((email) => email.to === 'new@staff.test' && email.text.includes(token))).toBe(true);

        expect((await api().get(`/v1/admin/auth/invite/${token}`)).body).toMatchObject({ email: 'new@staff.test', role: 'ads' });
        await api().post(`/v1/admin/auth/invite/${token}`).send({ password: STRONG }).expect(200);
        expect((await api().post(`/v1/admin/auth/invite/${token}`).send({ password: STRONG })).status).toBe(404);
        expect((await api().post('/v1/admin/auth/login').send({ email: 'new@staff.test', password: STRONG })).body.step).toBe('setup_2fa');

        const id = invited.body.staff.id;
        expect((await owner.agent.patch(`/v1/admin/staff/${id}`).send({ role: 'moderator' })).body.staff.role).toBe('moderator');
        await owner.agent.post(`/v1/admin/staff/${admin.account.id}/reset-2fa`).expect(200);
        // Their session ended with it
        expect((await admin.agent.get('/v1/admin/overview')).status).toBe(401);
        await owner.agent.patch(`/v1/admin/staff/${id}`).send({ disabled: true }).expect(200);
        expect((await api().post('/v1/admin/auth/login').send({ email: 'new@staff.test', password: STRONG })).status).toBe(401);

        // The last owner stays
        expect((await owner.agent.patch(`/v1/admin/staff/${owner.account.id}`).send({ role: 'admin' })).status).toBe(403);
        const actions = (await owner.agent.get('/v1/admin/audit')).body.entries.map((entry: { action: string }) => entry.action);
        expect(actions).toEqual(expect.arrayContaining(['invite_staff', 'update_staff', 'reset_staff_2fa', 'deactivate_staff', 'accept_invite']));
    });

    it('moderates any community from the panel, logged as staff', async () => {
        const staff = await signInStaff('root', 'moderator');
        const alice = await signUp('alice');
        await alice.agent.post('/v1/communities').send({ name: 'Lounge' }).expect(201);
        const post = (await alice.agent.post('/v1/posts').send({ community: 'lounge', title: 'Something off' })).body.post;

        const removed = await staff.agent.post(`/v1/admin/posts/${post.id}/moderation`).send({ action: 'remove', reason: 'Spam' });
        expect(removed.body.post.status).toBe('removed');
        const log = await staff.agent.get('/v1/admin/mod-log');
        expect(log.body.actions[0]).toMatchObject({ action: 'remove_post', actor: null, staff: { name: 'root' } });
        // The community's own mod log shows it too
        expect((await alice.agent.get('/v1/communities/lounge/mod-log')).body.actions[0].action).toBe('remove_post');
    });
});
