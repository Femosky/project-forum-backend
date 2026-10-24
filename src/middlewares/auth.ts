import { NextFunction, Request, Response } from 'express';
import { User } from '@prisma/client';
import prisma from '../prismaConnection';
import { unauthorized } from '../lib/http';
import { ACCESS_COOKIE, verifyAccessToken } from '../modules/auth/tokens';
import { trackActive } from '../lib/analytics';

export type Viewer = { user: User; sessionId: string };
export type AuthRequest = Request & { viewer?: Viewer; viewerResolved?: boolean };

// Resolves the signed-in user from the access token cookie (or a Bearer header). Returns null for guests,
// expired tokens, revoked sessions and accounts that can no longer sign in.
async function resolveViewer(request: AuthRequest): Promise<Viewer | null> {
    // Resolved once per request, however many middlewares ask
    if (request.viewerResolved) return request.viewer ?? null;
    request.viewerResolved = true;
    request.viewer = (await lookupViewer(request)) ?? undefined;
    if (request.viewer) trackActive(request.viewer.user.id);
    return request.viewer ?? null;
}

async function lookupViewer(request: Request): Promise<Viewer | null> {
    const header = request.headers.authorization;
    const token = request.cookies?.[ACCESS_COOKIE] ?? (header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    if (!token) return null;

    const claims = verifyAccessToken(token);
    if (!claims) return null;

    const session = await prisma.session.findUnique({ where: { id: claims.sid }, include: { user: true } });
    if (!session || session.revoked_at || session.expires_at <= new Date()) return null;
    if (session.user.status !== 'active') return null;

    return { user: session.user, sessionId: session.id };
}

export async function requireAuth(request: AuthRequest, response: Response, next: NextFunction) {
    const viewer = await resolveViewer(request);
    if (!viewer) throw unauthorized();
    request.viewer = viewer;
    next();
}

// For public routes that show extra detail (your vote, your anonymous posts) to signed-in users
export async function optionalAuth(request: AuthRequest, response: Response, next: NextFunction) {
    request.viewer = (await resolveViewer(request)) ?? undefined;
    next();
}

export function viewerOf(request: Request): Viewer {
    const viewer = (request as AuthRequest).viewer;
    if (!viewer) throw unauthorized();
    return viewer;
}
