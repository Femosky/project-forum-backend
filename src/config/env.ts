import 'dotenv/config';
import { z } from 'zod';

// Validated once at boot; the server refuses to start with a missing or weak setting.
const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(3001),
    DATABASE_URL: z.string().min(1),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    // Comma-separated list of allowed web origins, e.g. https://forum.oskeylabs.com
    WEB_ORIGIN: z.string().default('http://localhost:3000'),
    // Set to the shared parent domain (e.g. .oskeylabs.com) when the web app and API are on different subdomains
    COOKIE_DOMAIN: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    console.error('Invalid environment configuration:');
    for (const issue of parsed.error.issues) {
        console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
}

export const env = {
    ...parsed.data,
    WEB_ORIGINS: parsed.data.WEB_ORIGIN.split(',').map((origin) => origin.trim()),
    IS_PRODUCTION: parsed.data.NODE_ENV === 'production',
};
