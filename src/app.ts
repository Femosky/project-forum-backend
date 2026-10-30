import { env } from './config/env';
import { randomUUID } from 'node:crypto';
import express, { Router } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import logger from './lib/logger';
import { MemoryStore } from 'express-rate-limit';
import { limiter } from './lib/rateLimit';
import { errorHandler, notFoundHandler } from './lib/errors';
import { optionalAuth } from './middlewares/auth';
import { noteActivity } from './lib/jobs';
import authRoutes from './modules/auth/routes';
import communityRoutes from './modules/communities/routes';
import postRoutes from './modules/posts/routes';
import commentRoutes from './modules/comments/routes';
import userRoutes from './modules/users/routes';
import feedRoutes from './modules/feed/routes';
import searchRoutes from './modules/search/routes';
import moderationRoutes from './modules/moderation/routes';
import moderationTeamRoutes from './modules/moderation/team';
import notificationRoutes from './modules/notifications/routes';
import seoRoutes from './modules/seo/routes';
import adminRoutes from './modules/admin/routes';
import { auditRoutes, staffAuthRoutes, staffRoutes } from './modules/staff/routes';
import adsRoutes from './modules/ads/routes';
import metricsRoutes from './modules/metrics/routes';
import trendingRoutes from './modules/trending/routes';
import imageRoutes from './modules/images/routes';
import { LOCAL_MEDIA_DIR, storageDriver } from './lib/storage';

const app = express();

// Behind a hosting proxy, so request.ip and rate limiting see the real client IP
app.set('trust proxy', 1);

// Request logs with an id per request. A caller's X-Request-Id is kept if it looks sane, so logs can be joined up.
app.use(
    pinoHttp({
        logger,
        genReqId: (request, response) => {
            const incoming = request.headers['x-request-id'];
            const id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
            response.setHeader('X-Request-Id', id);
            return id;
        },
        customLogLevel: (request, response, error) =>
            error || response.statusCode >= 500 ? 'error' : response.statusCode >= 400 ? 'warn' : 'info',
        serializers: {
            req: (request) => ({ id: request.id, method: request.method, url: request.url }),
            res: (response) => ({ statusCode: response.statusCode }),
        },
    })
);

// Anything but a health check counts as the site being used: an idle job queue starts again (lib/jobs.ts). Uptime
// monitors ping /v1/health, which touches neither the database nor this.
app.use((request, response, next) => {
    if (request.path !== '/v1/health') noteActivity();
    next();
});

app.use(helmet());
app.use(cors({ origin: env.WEB_ORIGINS, credentials: true, exposedHeaders: ['X-Request-Id'] }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// Rate limits. Auth and write limits are stored in Postgres (RATE_LIMIT_STORE) so they hold across instances;
// the read limit only slows down aggressive scrapers, so it stays in memory.
const authLimiter = limiter({
    name: 'auth',
    windowMs: 15 * 60 * 1000,
    limit: 20,
    message: 'Too many attempts, please try again later.',
});
// New accounts per IP (Phase 5): a handful a day is plenty for a household or office; scripted signups stop here
const signupLimiter = limiter({
    name: 'signup',
    windowMs: 24 * 60 * 60 * 1000,
    limit: 5,
    message: 'Too many new accounts from this network today. Please try again tomorrow.',
});
const writeLimiter = limiter({
    name: 'write',
    windowMs: 60 * 1000,
    limit: 60,
    skipGet: true,
    message: 'Too many requests, please slow down.',
});
const readLimiter = limiter({
    name: 'read',
    windowMs: 60 * 1000,
    limit: 300,
    message: 'Too many requests, please slow down.',
    store: new MemoryStore(),
});

// --- v1 API ---
const v1 = Router();
v1.use(readLimiter);
for (const path of ['/auth/signup', '/auth/login', '/auth/forgot-password', '/auth/reset-password', '/auth/google', '/auth/verify-email']) {
    v1.use(path, authLimiter);
}
v1.post('/auth/signup', signupLimiter);
// Page-view beacons arrive once per page, so they skip the write limit (the read limit still applies)
v1.use('/metrics', metricsRoutes);
// Identify the caller before the write limiter so limits are per account where possible
v1.use(optionalAuth, writeLimiter);
v1.use('/auth', authRoutes);
v1.use('/feed', feedRoutes);
v1.use('/communities', communityRoutes);
v1.use('/posts', postRoutes);
v1.use('/comments', commentRoutes);
v1.use('/users', userRoutes);
v1.use('/search', searchRoutes);
v1.use('/trending', trendingRoutes);
v1.use('/images', imageRoutes);
v1.use('/notifications', notificationRoutes);
v1.use('/seo', seoRoutes);
// The admin panel: staff sign-in first (it limits failed attempts itself: staff/routes.ts), then everything else needs a
// staff session
v1.use('/admin/auth', staffAuthRoutes);
v1.use('/admin/staff', staffRoutes);
v1.use('/admin/audit', auditRoutes);
v1.use('/admin', adminRoutes);
v1.use('/ads', adsRoutes);
v1.use(moderationRoutes);
v1.use(moderationTeamRoutes);
v1.get('/health', (request, response) => {
    response.json({ status: 'ok' });
});
app.use('/v1', v1);

// Uploaded images on local disk (development; production serves them from R2). File names are never reused.
if (storageDriver() === 'local') {
    app.use(
        '/media',
        express.static(LOCAL_MEDIA_DIR, {
            immutable: true,
            maxAge: '365d',
            fallthrough: false,
            setHeaders: (response) => response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'),
        })
    );
}

app.get('/', (request, response) => {
    response.send('Welcome to the "Project Forum" API. See /v1.');
});

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
