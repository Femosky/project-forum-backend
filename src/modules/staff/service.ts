import { createHash, randomBytes } from 'node:crypto';
import { NextFunction, Request, Response, CookieOptions } from 'express';
import { Prisma, StaffAccount, StaffRole, StaffSession } from '@prisma/client';
import prisma from '../../prismaConnection';
import { env } from '../../config/env';
import { forbidden, HttpError, unauthorized } from '../../lib/http';
import { ViewerContext } from '../communities/access';

// Staff sessions for the admin panel. Separate from forum sign-in in every way: their own accounts, their own cookie
// (staff_session, sent only to /admin on the web app and /v1/admin on the API), two-factor on every sign-in, short
// lives (12 hours, or 2 hours unused), and an audit log of everything done with them.

export const STAFF_COOKIE = 'staff_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const IDLE_MS = 2 * 60 * 60 * 1000;
// Between the password and the authenticator code
export const PENDING_MS = 15 * 60 * 1000;
const COOKIE_PATHS = ['/v1/admin', '/admin'];

export type StaffRequest = Request & { staff?: { account: StaffAccount; session: StaffSession } };

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const tokenHash = hashToken;

function cookieOptions(path: string, maxAge?: number): CookieOptions {
    return { httpOnly: true, secure: env.IS_PRODUCTION, sameSite: 'strict', domain: env.COOKIE_DOMAIN, path, ...(maxAge ? { maxAge } : {}) };
}

export async function startSession(response: Response, request: Request, account: StaffAccount) {
    const token = newToken();
    const session = await prisma.staffSession.create({
        data: {
            staff_id: account.id,
            token_hash: hashToken(token),
            expires_at: new Date(Date.now() + PENDING_MS),
            ip_address: request.ip ?? null,
            user_agent: request.get('user-agent')?.slice(0, 512) ?? null,
        },
    });
    for (const path of COOKIE_PATHS) response.cookie(STAFF_COOKIE, token, cookieOptions(path, SESSION_MS));
    return session;
}

// The second step is done: the session becomes a full one
export async function completeSession(session: StaffSession) {
    return prisma.staffSession.update({
        where: { id: session.id },
        data: { mfa_verified_at: new Date(), expires_at: new Date(Date.now() + SESSION_MS), last_used_at: new Date() },
    });
}

export function clearStaffCookies(response: Response) {
    for (const path of COOKIE_PATHS) response.clearCookie(STAFF_COOKIE, cookieOptions(path));
}

async function loadSession(request: Request) {
    const token = request.cookies?.[STAFF_COOKIE];
    if (!token || typeof token !== 'string') return null;
    const session = await prisma.staffSession.findUnique({ where: { token_hash: hashToken(token) }, include: { staff: true } });
    if (!session || session.revoked_at || session.expires_at <= new Date()) return null;
    if (session.mfa_verified_at && Date.now() - session.last_used_at.getTime() > IDLE_MS) return null;
    if (session.staff.disabled_at) return null;
    return session;
}

// A session that has the password but not yet the authenticator code (sign-in steps only)
export async function requirePendingSession(request: StaffRequest, response: Response, next: NextFunction) {
    const session = await loadSession(request);
    if (!session) throw unauthorized('Sign in again.', 'staff_session_missing');
    const { staff, ...rest } = session;
    request.staff = { account: staff, session: rest };
    next();
}

// A full staff session, optionally limited to some roles. Accounts still on a temporary password can do nothing
// but change it.
export function requireStaff(...roles: StaffRole[]) {
    return async (request: StaffRequest, response: Response, next: NextFunction) => {
        const session = request.staff ? { ...request.staff.session, staff: request.staff.account } : await loadSession(request);
        if (!session || !session.mfa_verified_at) throw unauthorized('Sign in to the admin panel.', 'staff_unauthorized');
        if (session.staff.password_temporary) throw new HttpError(403, 'password_change_required', 'Set a new password first.');
        if (roles.length && !roles.includes(session.staff.role)) throw forbidden("Your admin role can't do that.", 'staff_forbidden');
        if (!request.staff && Date.now() - session.last_used_at.getTime() > 60_000) {
            await prisma.staffSession.update({ where: { id: session.id }, data: { last_used_at: new Date() } });
        }
        const { staff, ...rest } = session;
        request.staff = { account: staff, session: rest };
        next();
    };
}

export function staffOf(request: Request) {
    const staff = (request as StaffRequest).staff;
    if (!staff) throw unauthorized('Sign in to the admin panel.', 'staff_unauthorized');
    return staff.account;
}

// Lets staff read content the way site-wide moderators do: every community, anonymous authors, held and
// shadow-hidden items
export const STAFF_CONTEXT: ViewerContext = { userId: '00000000-0000-0000-0000-000000000000', isAdmin: true, moderates: new Set() };

// The audit log: who, what, on what, from where
export function audit(request: Request, action: string, target?: { type: string; id: string }, details?: Prisma.InputJsonValue) {
    return prisma.staffAudit.create({
        data: {
            staff_id: (request as StaffRequest).staff?.account.id ?? null,
            action,
            target_type: target?.type ?? null,
            target_id: target?.id ?? null,
            details,
            ip_address: request.ip ?? null,
        },
    });
}

export async function revokeSessions(staffId: string) {
    await prisma.staffSession.updateMany({ where: { staff_id: staffId, revoked_at: null }, data: { revoked_at: new Date() } });
}

export function publicStaff(account: StaffAccount) {
    return {
        id: account.id,
        email: account.email,
        name: account.name,
        role: account.role,
        has_password: account.password_hash !== null,
        has_2fa: account.totp_enabled_at !== null,
        password_change_required: account.password_temporary,
        disabled_at: account.disabled_at,
        last_login_at: account.last_login_at,
        created_at: account.created_at,
    };
}
