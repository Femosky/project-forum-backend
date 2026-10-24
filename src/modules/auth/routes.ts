import { Request, Response, Router } from 'express';
import prisma from '../../prismaConnection';
import { HttpError, badRequest, conflict, notFound, parse, unauthorized, uuidParam } from '../../lib/http';
import { createStore } from '../../lib/rateLimit';
import { isTurnstileEnabled, requireTurnstile } from '../../lib/turnstile';
import { AuthRequest, requireAuth, viewerOf } from '../../middlewares/auth';
import { verifyGoogleIdToken } from './google';
import {
    changeEmailSchema,
    changePasswordSchema,
    forgotPasswordSchema,
    googleSchema,
    loginSchema,
    resetPasswordSchema,
    signupSchema,
    tokenSchema,
} from './schema';
import {
    assertAvailable,
    assertCanSignIn,
    consumeToken,
    createSession,
    createUser,
    findUserByIdentifier,
    hashPassword,
    refreshSession,
    revokeAllSessions,
    revokeSessionByRefreshToken,
    sendEmailChangeConfirmation,
    sendPasswordResetEmail,
    sendVerificationEmail,
    toPrivateUser,
    verifyPassword,
} from './service';
import { clearAuthCookies, REFRESH_COOKIE, setAccessCookie, setAuthCookies } from './tokens';

const router = Router();

const INVALID_CREDENTIALS = 'Invalid email, username or password.';

// Failed logins per identifier (known or not, so the response never hints whether an account exists).
// After a few failures a Turnstile challenge is required; after more, logins pause until the window ends.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const CHALLENGE_AFTER = 3;
const LOCK_AFTER = 10;
const failedLogins = createStore('login-failures', LOGIN_WINDOW_MS);

export async function login(request: Request, response: Response) {
    const input = parse(loginSchema, request.body);
    const key = input.identifier!.toLowerCase();

    const failures = (await failedLogins.get(key))?.totalHits ?? 0;
    if (failures >= LOCK_AFTER) {
        throw new HttpError(429, 'too_many_attempts', 'Too many failed attempts. Try again in 15 minutes.');
    }
    if (failures >= CHALLENGE_AFTER && isTurnstileEnabled()) {
        await requireTurnstile(input.turnstile_token, request.ip);
    }

    const user = await findUserByIdentifier(input.identifier!);
    const isValid = user ? await verifyPassword(input.password, user.password_hash) : false;
    if (!user || !isValid) {
        await failedLogins.increment(key);
        throw unauthorized(INVALID_CREDENTIALS, 'invalid_credentials');
    }
    const allowed = await assertCanSignIn(user);
    await failedLogins.resetKey(key);

    setAuthCookies(response, await createSession(allowed, request));
    response.json({ success: true, user: toPrivateUser(allowed) });
}

export async function logout(request: Request, response: Response) {
    await revokeSessionByRefreshToken(request.cookies?.[REFRESH_COOKIE]);
    clearAuthCookies(response);
    response.json({ success: true, message: 'Logged out successfully.' });
}

export async function refresh(request: Request, response: Response) {
    try {
        const result = await refreshSession(request.cookies?.[REFRESH_COOKIE]);
        if ('tokens' in result) setAuthCookies(response, result.tokens);
        else setAccessCookie(response, result.accessToken);
        response.json({ success: true, message: 'Session refreshed.' });
    } catch (error) {
        clearAuthCookies(response);
        throw error;
    }
}

router.post('/signup', async (request, response) => {
    const input = parse(signupSchema, request.body);
    await requireTurnstile(input.turnstile_token, request.ip);
    await assertAvailable(input.email, input.username);

    const user = await createUser({
        email: input.email,
        username: input.username,
        password_hash: await hashPassword(input.password),
    });
    await sendVerificationEmail(user);

    setAuthCookies(response, await createSession(user, request));
    response.status(201).json({ user: toPrivateUser(user) });
});

router.post('/login', login);
router.post('/logout', logout);
router.post('/refresh', refresh);

router.get('/me', requireAuth, async (request: AuthRequest, response) => {
    response.json({ user: toPrivateUser(viewerOf(request).user) });
});

router.post('/verify-email', async (request, response) => {
    const { token } = parse(tokenSchema, request.body);
    const record = await consumeToken(token, 'verify_email');
    await prisma.user.update({ where: { id: record.user_id }, data: { email_verified_at: new Date() } });
    response.json({ success: true });
});

router.post('/resend-verification', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    if (user.email_verified_at) throw badRequest('Your email is already confirmed.', 'already_verified');
    await sendVerificationEmail(user);
    response.json({ success: true });
});

// Always answers the same way, so it can't be used to find out who has an account
router.post('/forgot-password', async (request, response) => {
    const input = parse(forgotPasswordSchema, request.body);
    await requireTurnstile(input.turnstile_token, request.ip);
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (user && user.status === 'active') await sendPasswordResetEmail(user);
    response.json({ success: true, message: 'If that email has an account, a reset link is on its way.' });
});

router.post('/reset-password', async (request, response) => {
    const input = parse(resetPasswordSchema, request.body);
    const record = await consumeToken(input.token, 'reset_password');
    await prisma.user.update({
        where: { id: record.user_id },
        // Clicking the emailed link also proves the address
        data: { password_hash: await hashPassword(input.password), email_verified_at: new Date() },
    });
    await revokeAllSessions(record.user_id);
    response.json({ success: true });
});

router.post('/change-password', requireAuth, async (request: AuthRequest, response) => {
    const { user, sessionId } = viewerOf(request);
    const input = parse(changePasswordSchema, request.body);
    // Google-only accounts may set a first password without a current one
    if (user.password_hash && !(await verifyPassword(input.current_password ?? '', user.password_hash))) {
        throw badRequest('Your current password is wrong.', 'wrong_password');
    }
    await prisma.user.update({ where: { id: user.id }, data: { password_hash: await hashPassword(input.new_password) } });
    await revokeAllSessions(user.id, sessionId);
    response.json({ success: true });
});

router.post('/change-email', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const input = parse(changeEmailSchema, request.body);
    if (!(await verifyPassword(input.password, user.password_hash))) {
        throw badRequest('Your password is wrong.', 'wrong_password');
    }
    if (input.new_email === user.email) throw badRequest('That is already your email.', 'same_email');
    if (await prisma.user.findUnique({ where: { email: input.new_email } })) {
        throw conflict('An account with that email already exists.', 'email_taken');
    }
    await sendEmailChangeConfirmation(user, input.new_email);
    response.json({ success: true, message: 'Check your new inbox for a confirmation link.' });
});

router.post('/confirm-email', async (request, response) => {
    const { token } = parse(tokenSchema, request.body);
    const record = await consumeToken(token, 'change_email');
    if (!record.new_email) throw badRequest('This link is invalid or has expired.', 'invalid_token');
    try {
        await prisma.user.update({
            where: { id: record.user_id },
            data: { email: record.new_email, email_verified_at: new Date() },
        });
    } catch {
        throw conflict('An account with that email already exists.', 'email_taken');
    }
    response.json({ success: true });
});

router.post('/google', async (request, response) => {
    const input = parse(googleSchema, request.body);
    const identity = await verifyGoogleIdToken(input.id_token);

    let user =
        (await prisma.user.findUnique({ where: { google_id: identity.googleId } })) ??
        (await prisma.user.findUnique({ where: { email: identity.email } }));

    if (user && !user.google_id) {
        // Google has verified the address, so linking to the existing account is safe
        user = await prisma.user.update({
            where: { id: user.id },
            data: { google_id: identity.googleId, email_verified_at: user.email_verified_at ?? new Date() },
        });
    }

    let created = false;
    if (!user) {
        if (!input.is_adult) {
            throw new HttpError(400, 'adult_attestation_required', 'Confirm you are 18 or older to join.');
        }
        user = await createUser({
            email: identity.email,
            username: await suggestUsername(identity.email),
            google_id: identity.googleId,
            verified: true,
        });
        created = true;
    }

    user = await assertCanSignIn(user);
    setAuthCookies(response, await createSession(user, request));
    response.status(created ? 201 : 200).json({ user: toPrivateUser(user), created });
});

// A free username based on the email's local part, e.g. "ada.obi@..." becomes "ada_obi" or "ada_obi_4821"
async function suggestUsername(email: string) {
    let base = email
        .split('@')[0]
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^[^a-z]+/, '')
        .slice(0, 14);
    if (base.length < 3) base = `user${base}`;
    for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = attempt === 0 ? base : `${base}_${Math.floor(1000 + Math.random() * 9000)}`;
        if (!(await prisma.user.findUnique({ where: { username: candidate } }))) return candidate;
    }
    return `user_${Date.now().toString(36)}`;
}

// Signed-in devices, newest first
router.get('/sessions', requireAuth, async (request: AuthRequest, response) => {
    const { user, sessionId } = viewerOf(request);
    const sessions = await prisma.session.findMany({
        where: { user_id: user.id, revoked_at: null, expires_at: { gt: new Date() } },
        orderBy: { last_used_at: 'desc' },
        select: {
            id: true,
            created_at: true,
            last_used_at: true,
            browser: true,
            os: true,
            device_type: true,
            country: true,
            city: true,
        },
    });
    response.json({ sessions: sessions.map((session) => ({ ...session, current: session.id === sessionId })) });
});

router.delete('/sessions/:id', requireAuth, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const result = await prisma.session.updateMany({
        where: { id: uuidParam(request.params.id, 'Session not found'), user_id: user.id, revoked_at: null },
        data: { revoked_at: new Date() },
    });
    if (result.count === 0) throw notFound('Session not found');
    response.json({ success: true });
});

// Signs out every other device
router.delete('/sessions', requireAuth, async (request: AuthRequest, response) => {
    const { user, sessionId } = viewerOf(request);
    await revokeAllSessions(user.id, sessionId);
    response.json({ success: true });
});

export default router;
