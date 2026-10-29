import { Request, Router } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { createStore } from '../../lib/rateLimit';
import { z } from 'zod';
import QRCode from 'qrcode';
import prisma from '../../prismaConnection';
import { env } from '../../config/env';
import { badRequest, conflict, forbidden, HttpError, notFound, parse, unauthorized, uuidParam } from '../../lib/http';
import { requireTurnstile } from '../../lib/turnstile';
import { linkEmail } from '../../lib/email';
import { emailJob } from '../auth/jobs';
import { hashPassword, verifyPassword } from '../auth/service';
import { email, password } from '../../shared/validation';
import { afterCursor, decodeCursor, paginate } from '../../lib/cursor';
import { pageQuery } from '../../shared/validation';
import {
    audit,
    clearStaffCookies,
    completeSession,
    newToken,
    publicStaff,
    requirePendingSession,
    requireStaff,
    revokeSessions,
    StaffRequest,
    staffOf,
    startSession,
    tokenHash,
} from './service';
import { decryptSecret, encryptSecret, hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUrl, verifyTotp } from './totp';

// /v1/admin/auth: signing in to the admin panel (password, then an authenticator code), accepting an invite, and
// changing the password. /v1/admin/staff: the owner manages staff accounts. /v1/admin/audit: the audit log.

export const staffAuthRoutes = Router();
export const staffRoutes = Router();

const ISSUER = 'Project Forum admin';

// Only failed attempts count towards the sign-in limit: a wrong password or a wrong code. Page loads, session checks
// and successful steps never do. 5 failures per account from one network in 15 minutes, and 20 from one network
// across accounts; a success clears the account's count. Counting per account and network (not per account alone)
// means nobody can lock the owner out by guessing from elsewhere.
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_ACCOUNT = 5;
const MAX_FAILURES_PER_NETWORK = 20;
const failures = createStore('staff-auth-fail', FAILURE_WINDOW_MS);

function failureKeys(request: Request, who: string) {
    const network = ipKeyGenerator(request.ip ?? '');
    return { account: { key: `${who.toLowerCase()}|${network}`, max: MAX_FAILURES_PER_ACCOUNT }, network: { key: network, max: MAX_FAILURES_PER_NETWORK } };
}

async function assertAttemptsLeft(keys: ReturnType<typeof failureKeys>) {
    for (const { key, max } of [keys.account, keys.network]) {
        const count = await failures.get(key);
        if (count && count.totalHits >= max) {
            const minutes = Math.max(1, Math.ceil(((count.resetTime?.getTime() ?? Date.now()) - Date.now()) / 60_000));
            throw new HttpError(429, 'too_many_attempts', `Too many wrong attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
        }
    }
}

async function recordFailure(keys: ReturnType<typeof failureKeys>) {
    await Promise.all([failures.increment(keys.account.key), failures.increment(keys.network.key)]);
}
const INVITE_MS = 7 * 24 * 60 * 60 * 1000;

const loginSchema = z.object({ email, password: z.string().min(1).max(200), turnstile_token: z.string().max(4096).optional() });
const codeSchema = z.object({ code: z.string().trim().max(12).optional(), recovery_code: z.string().trim().max(20).optional() });

staffAuthRoutes.post('/login', async (request, response) => {
    const input = parse(loginSchema, request.body);
    await requireTurnstile(input.turnstile_token, request.ip);

    const keys = failureKeys(request, input.email);
    await assertAttemptsLeft(keys);

    const account = await prisma.staffAccount.findUnique({ where: { email: input.email } });
    const wrong = async () => {
        await recordFailure(keys);
        return unauthorized('Wrong email or password.', 'invalid_credentials');
    };
    if (!account || account.disabled_at || !account.password_hash) {
        // Same work and answer whether or not the account exists
        await verifyPassword(input.password, null);
        throw await wrong();
    }
    if (!(await verifyPassword(input.password, account.password_hash))) {
        await prisma.staffAudit.create({ data: { staff_id: account.id, action: 'login_failed', ip_address: request.ip ?? null } });
        throw await wrong();
    }

    await failures.resetKey(keys.account.key);
    await startSession(response, request, account);
    response.json({ step: account.totp_enabled_at ? 'verify_2fa' : 'setup_2fa' });
});

// First sign-in: a new authenticator secret to scan. Kept (encrypted) until a code from it is entered.
staffAuthRoutes.get('/2fa/setup', requirePendingSession, async (request: StaffRequest, response) => {
    const account = request.staff!.account;
    if (account.totp_enabled_at) throw badRequest('Two-factor sign-in is already set up.', 'totp_exists');
    const secret = account.totp_secret ? decryptSecret(account.totp_secret) : newTotpSecret();
    if (!account.totp_secret) await prisma.staffAccount.update({ where: { id: account.id }, data: { totp_secret: encryptSecret(secret) } });
    const url = otpauthUrl(secret, account.email, ISSUER);
    response.setHeader('Cache-Control', 'no-store');
    response.json({ secret, otpauth_url: url, qr_svg: await QRCode.toString(url, { type: 'svg', margin: 1 }) });
});

staffAuthRoutes.post('/2fa/setup', requirePendingSession, async (request: StaffRequest, response) => {
    const { account, session } = request.staff!;
    const { code } = parse(codeSchema, request.body);
    if (account.totp_enabled_at || !account.totp_secret) throw badRequest('Start the setup again.', 'totp_setup_missing');
    const keys = failureKeys(request, account.email);
    await assertAttemptsLeft(keys);
    if (!code || !verifyTotp(decryptSecret(account.totp_secret), code)) {
        await recordFailure(keys);
        throw badRequest("That code didn't match. Check the time on your phone and try the newest code.", 'invalid_code');
    }
    await failures.resetKey(keys.account.key);

    const recovery = newRecoveryCodes();
    const updated = await prisma.staffAccount.update({
        where: { id: account.id },
        data: { totp_enabled_at: new Date(), recovery_codes: recovery.map(hashRecoveryCode), last_login_at: new Date() },
    });
    await completeSession(session);
    request.staff!.account = updated;
    await audit(request, 'setup_2fa');
    await audit(request, 'login');
    response.setHeader('Cache-Control', 'no-store');
    response.json({ recovery_codes: recovery, staff: publicStaff(updated) });
});

staffAuthRoutes.post('/2fa/verify', requirePendingSession, async (request: StaffRequest, response) => {
    const { account, session } = request.staff!;
    const input = parse(codeSchema, request.body);
    if (!account.totp_enabled_at || !account.totp_secret) throw badRequest('Set up two-factor sign-in first.', 'totp_missing');
    const keys = failureKeys(request, account.email);
    await assertAttemptsLeft(keys);

    let ok = Boolean(input.code && verifyTotp(decryptSecret(account.totp_secret), input.code));
    let codes = (account.recovery_codes as string[] | null) ?? [];
    if (!ok && input.recovery_code) {
        const hash = hashRecoveryCode(input.recovery_code);
        ok = codes.includes(hash);
        // Each recovery code works once
        if (ok) codes = codes.filter((code) => code !== hash);
    }
    if (!ok) {
        await recordFailure(keys);
        await prisma.staffAudit.create({ data: { staff_id: account.id, action: 'login_2fa_failed', ip_address: request.ip ?? null } });
        throw badRequest("That code didn't match.", 'invalid_code');
    }
    await failures.resetKey(keys.account.key);
    const updated = await prisma.staffAccount.update({ where: { id: account.id }, data: { recovery_codes: codes, last_login_at: new Date() } });
    await completeSession(session);
    request.staff!.account = updated;
    await audit(request, input.recovery_code && !input.code ? 'login_recovery_code' : 'login', undefined, { recovery_codes_left: codes.length });
    response.json({ staff: publicStaff(updated), recovery_codes_left: codes.length });
});

// Signed in (both steps), even on a temporary password, so the page can ask for a new one
staffAuthRoutes.get('/me', requirePendingSession, async (request: StaffRequest, response) => {
    const { account, session } = request.staff!;
    if (!session.mfa_verified_at) throw unauthorized('Finish signing in.', 'staff_unauthorized');
    response.setHeader('Cache-Control', 'private, no-store');
    response.json({ staff: publicStaff(account) });
});

const passwordSchema = z.object({ current_password: z.string().min(1).max(200), new_password: password });

staffAuthRoutes.post('/password', requirePendingSession, async (request: StaffRequest, response) => {
    const { account, session } = request.staff!;
    if (!session.mfa_verified_at) throw unauthorized('Finish signing in.', 'staff_unauthorized');
    const input = parse(passwordSchema, request.body);
    if (!(await verifyPassword(input.current_password, account.password_hash))) throw badRequest('Your current password is wrong.', 'wrong_password');
    if (input.current_password === input.new_password) throw badRequest('Pick a new password.', 'same_password');
    const updated = await prisma.staffAccount.update({
        where: { id: account.id },
        data: { password_hash: await hashPassword(input.new_password), password_temporary: false },
    });
    // Other devices sign in again
    await prisma.staffSession.updateMany({ where: { staff_id: account.id, id: { not: session.id }, revoked_at: null }, data: { revoked_at: new Date() } });
    await audit(request, 'change_password');
    response.json({ staff: publicStaff(updated) });
});

staffAuthRoutes.post('/logout', async (request: StaffRequest, response) => {
    const token = request.cookies?.staff_session;
    if (typeof token === 'string') {
        await prisma.staffSession.updateMany({ where: { token_hash: tokenHash(token), revoked_at: null }, data: { revoked_at: new Date() } });
    }
    clearStaffCookies(response);
    response.json({ success: true });
});

// --- Invites: a one-time link to set a password (two-factor is set up at the first sign-in) ---

const inviteToken = z.string().regex(/^[\w-]{20,100}$/);

async function findInvite(token: string) {
    const row = await prisma.staffToken.findUnique({ where: { token_hash: tokenHash(token) }, include: { staff: true } });
    if (!row || row.purpose !== 'invite' || row.used_at || row.expires_at <= new Date() || row.staff.disabled_at) {
        throw notFound('This invite link has expired or was already used. Ask the owner for a new one.', 'invite_invalid');
    }
    return row;
}

staffAuthRoutes.get('/invite/:token', async (request, response) => {
    const row = await findInvite(parse(inviteToken, request.params.token));
    response.json({ email: row.staff.email, name: row.staff.name, role: row.staff.role });
});

staffAuthRoutes.post('/invite/:token', async (request, response) => {
    const row = await findInvite(parse(inviteToken, request.params.token));
    const { password: newPassword } = parse(z.object({ password }), request.body);
    await prisma.$transaction([
        prisma.staffAccount.update({
            where: { id: row.staff_id },
            data: { password_hash: await hashPassword(newPassword), password_temporary: false },
        }),
        prisma.staffToken.update({ where: { id: row.id }, data: { used_at: new Date() } }),
    ]);
    await revokeSessions(row.staff_id);
    await prisma.staffAudit.create({ data: { staff_id: row.staff_id, action: 'accept_invite', ip_address: request.ip ?? null } });
    response.json({ success: true });
});

// --- Staff accounts (owner only) ---

const roleSchema = z.enum(['owner', 'admin', 'ads', 'moderator']);
const createStaffSchema = z.object({ email, name: z.string().trim().min(1).max(60), role: roleSchema });
const updateStaffSchema = z
    .object({ name: z.string().trim().min(1).max(60).optional(), role: roleSchema.optional(), disabled: z.boolean().optional() })
    .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

async function sendInvite(account: { id: string; email: string; name: string }) {
    const token = newToken();
    await prisma.staffToken.create({ data: { staff_id: account.id, purpose: 'invite', token_hash: tokenHash(token), expires_at: new Date(Date.now() + INVITE_MS) } });
    const url = `${env.WEB_URL}/admin/invite?token=${token}`;
    await emailJob.enqueue(
        linkEmail(
            account.email,
            `You're invited to the ${ISSUER} panel`,
            `Hi ${account.name}, you've been given access to the admin panel. Set your password with this link; you'll set up an authenticator app when you first sign in.`,
            'Set your password',
            url,
            'The link works once and expires in 7 days.'
        )
    );
    return url;
}

staffRoutes.use(requireStaff('owner'));

staffRoutes.get('/', async (request, response) => {
    const accounts = await prisma.staffAccount.findMany({ orderBy: { created_at: 'asc' } });
    response.json({ staff: accounts.map(publicStaff) });
});

staffRoutes.post('/', async (request, response) => {
    const input = parse(createStaffSchema, request.body);
    if (await prisma.staffAccount.findUnique({ where: { email: input.email } })) throw conflict('There is already a staff account with that email.', 'staff_exists');
    const account = await prisma.staffAccount.create({ data: { ...input, created_by: staffOf(request).id } });
    const inviteUrl = await sendInvite(account);
    await audit(request, 'invite_staff', { type: 'staff', id: account.id }, { email: account.email, role: account.role });
    // The link is shown once too, for when email isn't set up yet
    response.status(201).json({ staff: publicStaff(account), invite_url: inviteUrl });
});

async function assertAnotherOwner(excludeId: string) {
    const owners = await prisma.staffAccount.count({ where: { role: 'owner', disabled_at: null, id: { not: excludeId } } });
    if (owners === 0) throw badRequest('There must always be at least one active owner.', 'last_owner');
}

staffRoutes.patch('/:id', async (request, response) => {
    const me = staffOf(request);
    const input = parse(updateStaffSchema, request.body);
    const target = await prisma.staffAccount.findUnique({ where: { id: uuidParam(request.params.id, 'Staff account not found') } });
    if (!target) throw notFound('Staff account not found');
    if (target.id === me.id && (input.role || input.disabled)) throw forbidden("You can't change your own role or deactivate yourself.", 'self_change');
    if (target.role === 'owner' && ((input.role && input.role !== 'owner') || input.disabled)) await assertAnotherOwner(target.id);

    const updated = await prisma.staffAccount.update({
        where: { id: target.id },
        data: {
            ...(input.name ? { name: input.name } : {}),
            ...(input.role ? { role: input.role } : {}),
            ...(input.disabled !== undefined ? { disabled_at: input.disabled ? new Date() : null } : {}),
        },
    });
    if (input.disabled) await revokeSessions(target.id);
    await audit(request, input.disabled === undefined ? 'update_staff' : input.disabled ? 'deactivate_staff' : 'reactivate_staff', { type: 'staff', id: target.id }, input);
    response.json({ staff: publicStaff(updated) });
});

// Lost phone: the next sign-in sets up a new authenticator
staffRoutes.post('/:id/reset-2fa', async (request, response) => {
    const target = await prisma.staffAccount.findUnique({ where: { id: uuidParam(request.params.id, 'Staff account not found') } });
    if (!target) throw notFound('Staff account not found');
    const updated = await prisma.staffAccount.update({ where: { id: target.id }, data: { totp_secret: null, totp_enabled_at: null, recovery_codes: [] } });
    await revokeSessions(target.id);
    await audit(request, 'reset_staff_2fa', { type: 'staff', id: target.id });
    response.json({ staff: publicStaff(updated) });
});

// A new one-time link to set a password (an invite again, or a forgotten password)
staffRoutes.post('/:id/invite', async (request, response) => {
    const target = await prisma.staffAccount.findUnique({ where: { id: uuidParam(request.params.id, 'Staff account not found') } });
    if (!target || target.disabled_at) throw notFound('Staff account not found');
    const inviteUrl = await sendInvite(target);
    await audit(request, 'resend_staff_invite', { type: 'staff', id: target.id });
    response.json({ invite_url: inviteUrl });
});

// --- Audit log (owner and admins) ---

export const auditRoutes = Router();
auditRoutes.use(requireStaff('owner', 'admin'));

auditRoutes.get('/', async (request, response) => {
    const query = parse(pageQuery.extend({ staff: z.uuid().optional() }), request.query);
    const rows = await prisma.staffAudit.findMany({
        where: { AND: [query.staff ? { staff_id: query.staff } : {}, afterCursor('created_at', 'desc', decodeCursor(query.cursor))] },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        include: { staff: { select: { name: true, email: true } } },
    });
    const { items, next_cursor } = paginate(rows, query.limit, 'created_at');
    response.json({ entries: items, next_cursor });
});
