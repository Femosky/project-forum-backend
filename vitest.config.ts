import { defineConfig } from 'vitest/config';

// Tests run against a throwaway local Postgres. Override TEST_DATABASE_URL to point elsewhere locally.
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/forum_test';

export default defineConfig({
    test: {
        environment: 'node',
        globalSetup: ['./tests/globalSetup.ts'],
        setupFiles: ['./tests/setup.ts'],
        // Tests share one database, so run files one at a time
        fileParallelism: false,
        env: {
            NODE_ENV: 'test',
            DATABASE_URL: testDatabaseUrl,
            JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
            WEB_ORIGIN: 'http://localhost:3000',
        },
    },
});
