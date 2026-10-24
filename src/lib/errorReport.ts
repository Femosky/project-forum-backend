import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import logger from './logger';

// Error alerts to Sentry (free tier), sent as plain HTTP "envelopes" rather than through the SDK, which would pull in
// OpenTelemetry for features this API doesn't use. Without SENTRY_DSN nothing is sent. Only unexpected errors (500s,
// crashes) are reported; request bodies, cookies and headers never are.

type Target = { url: string; dsn: string };

function parseDsn(dsn: string | undefined): Target | null {
    if (!dsn) return null;
    try {
        const { protocol, username, host, pathname } = new URL(dsn);
        const project = pathname.replace(/^\//, '');
        if (!username || !project) return null;
        return { url: `${protocol}//${host}/api/${project}/envelope/?sentry_key=${username}&sentry_version=7`, dsn };
    } catch {
        return null;
    }
}

const target = parseDsn(env.SENTRY_DSN);

// Repeats of the same error within a minute are sent once, so a broken route can't burn the monthly quota
const recent = new Map<string, number>();

export function reportError(error: unknown, context: { method?: string; path?: string; requestId?: string } = {}) {
    if (!target || env.IS_TEST) return;
    const err = error instanceof Error ? error : new Error(String(error));
    const key = `${err.name}:${err.message}:${context.path ?? ''}`;
    const now = Date.now();
    if ((recent.get(key) ?? 0) > now - 60_000) return;
    recent.set(key, now);
    if (recent.size > 500) recent.clear();

    const eventId = randomUUID().replace(/-/g, '');
    const event = {
        event_id: eventId,
        timestamp: now / 1000,
        platform: 'node',
        level: 'error',
        environment: env.NODE_ENV,
        release: process.env.RENDER_GIT_COMMIT,
        server_name: 'api',
        transaction: context.path ? `${context.method ?? ''} ${context.path}`.trim() : undefined,
        tags: { request_id: context.requestId },
        exception: { values: [{ type: err.name, value: err.message.slice(0, 1000) }] },
        extra: { stack: err.stack?.slice(0, 8000) },
    };
    const body = [JSON.stringify({ event_id: eventId, dsn: target.dsn }), JSON.stringify({ type: 'event' }), JSON.stringify(event)].join('\n');

    fetch(target.url, { method: 'POST', body, signal: AbortSignal.timeout(5000) }).catch((sendError) =>
        logger.warn({ err: sendError }, 'Error report failed')
    );
}
