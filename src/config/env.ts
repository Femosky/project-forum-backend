import 'dotenv/config';
import { z } from 'zod';

const booleanFlag = (fallback: boolean) =>
    z
        .enum(['true', 'false', '1', '0'])
        .optional()
        .transform((value) => (value === undefined ? fallback : value === 'true' || value === '1'));

// Validated once at boot; the server refuses to start with a missing or weak setting.
const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(3001),
    DATABASE_URL: z.string().min(1),
    // Optional direct (non-pooled) connection for the job queue; falls back to DATABASE_URL
    DIRECT_DATABASE_URL: z.string().optional(),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    // Comma-separated list of allowed web origins, e.g. https://forum.oskeylabs.com
    WEB_ORIGIN: z.string().default('http://localhost:3000'),
    // Base URL used in email links; defaults to the first WEB_ORIGIN
    WEB_URL: z.string().url().optional(),
    // Set to the shared parent domain (e.g. .oskeylabs.com) when the web app and API are on different subdomains
    COOKIE_DOMAIN: z.string().optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    // Rate limits: 'postgres' holds across instances (no Redis needed); 'memory' is per process
    RATE_LIMIT_STORE: z.enum(['postgres', 'memory']).default('postgres'),

    // Background jobs run on Postgres (pg-boss). When disabled, jobs run inline in the request.
    JOBS_ENABLED: booleanFlag(true),
    LINK_PREVIEWS_ENABLED: booleanFlag(true),

    // Email (Resend). Without a key, emails are logged instead of sent.
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().default('Project Forum <no-reply@forum.oskeylabs.com>'),

    // Google sign-in. Without a client id the endpoint answers 503.
    GOOGLE_CLIENT_ID: z.string().optional(),

    // Cloudflare Turnstile. Without a secret, challenges are skipped.
    TURNSTILE_SECRET_KEY: z.string().optional(),

    // IndexNow (Bing, Yandex and others): new posts are pinged so they're crawled within minutes. The web app serves
    // the same key at /indexnow-key.txt. Without a key nothing is sent.
    INDEXNOW_KEY: z
        .string()
        .regex(/^[a-zA-Z0-9-]{8,128}$/, 'INDEXNOW_KEY must be 8-128 letters, digits or dashes')
        .optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    console.error('Invalid environment configuration:');
    for (const issue of parsed.error.issues) {
        console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
}

const WEB_ORIGINS = parsed.data.WEB_ORIGIN.split(',').map((origin) => origin.trim());

export const env = {
    ...parsed.data,
    WEB_ORIGINS,
    WEB_URL: (parsed.data.WEB_URL ?? WEB_ORIGINS[0]).replace(/\/$/, ''),
    IS_PRODUCTION: parsed.data.NODE_ENV === 'production',
    IS_TEST: parsed.data.NODE_ENV === 'test',
};
