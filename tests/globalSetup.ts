import { execSync } from 'node:child_process';

export default function setup() {
    const url = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/forum_test';
    assertLocalDatabase(url);
    execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });
}

// The tests truncate every table, so never let them near a real database
export function assertLocalDatabase(url: string) {
    const host = new URL(url).hostname;
    const socket = new URL(url).searchParams.get('host');
    if (!['localhost', '127.0.0.1', ''].includes(host) && !socket?.startsWith('/')) {
        throw new Error(`Refusing to run tests against non-local database host "${host}"`);
    }
}
