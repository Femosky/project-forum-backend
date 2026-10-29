import express, { Router } from 'express';
import { z } from 'zod';
import { badRequest, parse } from '../../lib/http';
import { isBot } from '../../lib/bots';
import { lagosDay } from '../../lib/days';
import { AuthRequest, optionalAuth } from '../../middlewares/auth';
import { recordVisit } from './buffer';
import { countryOf, visitorId } from './visitors';

// Page views for the site's own stats (Admin -> Stats), sent by the browser after each page load, so guest pages
// served from the CDN cache still count. Mounted ahead of the write rate limit: one per page view is expected.

const router = Router();

const visitSchema = z.object({ path: z.string().trim().min(1).max(300).startsWith('/') });
const COMMUNITY_PATH = /^\/c\/([a-z][a-z0-9_]{2,20})(?:\/|$)/i;

// Plain-text bodies are accepted too, like /ads/events: no CORS preflight, and it survives the page closing
router.post('/visit', express.text({ type: 'text/plain', limit: '2kb' }), optionalAuth, async (request: AuthRequest, response) => {
    let body: unknown = request.body;
    if (typeof body === 'string') {
        try {
            body = JSON.parse(body);
        } catch {
            throw badRequest('Send JSON.', 'invalid_json');
        }
    }
    const { path } = parse(visitSchema, body);
    const userAgent = request.get('user-agent');
    if (isBot(userAgent) || !request.ip) {
        response.status(204).end();
        return;
    }

    const community = COMMUNITY_PATH.exec(path)?.[1]?.toLowerCase() ?? null;
    recordVisit({
        visitor: await visitorId(lagosDay(), request.ip, userAgent!),
        country: await countryOf(request),
        signedIn: Boolean(request.viewer),
        community: community === 'submit' ? null : community,
    });
    response.status(204).end();
});

export default router;
